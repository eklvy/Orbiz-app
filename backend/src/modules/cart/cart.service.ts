import { randomUUID } from 'node:crypto';
import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { POINT_VALUE_PAISE, maxRedeemablePoints } from '../loyalty/loyalty.rules.js';
import { hasStockFor, inStock, stockStatus } from '../inventory/stock.js';

export const MAX_QUANTITY = 10;
export const MAX_DISTINCT_ITEMS = 20;

const cartInclude = {
  items: {
    include: { menuItem: { include: { category: true, outlet: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

export type CartIssueReason = 'SOLD_OUT' | 'NO_LONGER_ON_MENU' | 'NOT_ENOUGH_STOCK';

/** "Only 3 left" — when a counted item has fewer units than the cart wants. */
const notEnough = (name: string, available: number) =>
  new AppError(409, 'INSUFFICIENT_STOCK', `Only ${available} ${name} left.`, { available });

/**
 * The cart as the browser sees it. Prices are always read live from the menu;
 * the cart itself stores only item IDs and quantities.
 */
export async function getCartView(db: DbClient, userId: string) {
  const [cart, wallet] = await Promise.all([
    db.cart.findUnique({ where: { userId }, include: cartInclude }),
    db.wallet.findUnique({ where: { userId }, select: { pointsBalance: true } }),
  ]);
  const availablePoints = wallet?.pointsBalance ?? 0;
  /** What checkout would accept right now (checkout re-checks everything). */
  const loyalty = (subtotalPaise: number) => ({
    availablePoints,
    maxRedeemablePoints: maxRedeemablePoints(subtotalPaise, availablePoints),
    pointValuePaise: POINT_VALUE_PAISE,
  });
  if (!cart || cart.items.length === 0) {
    return {
      outlet: null as null | {
        id: string;
        slug: string;
        name: string;
        status: string;
        acceptingOrders: boolean;
      },
      items: [] as ReturnType<typeof buildLineItem>[],
      itemCount: 0,
      subtotalPaise: 0,
      totalPaise: 0,
      issues: [] as CartIssue[],
      canCheckout: false,
      canSchedule: false,
      loyalty: loyalty(0),
      outletGroups: [] as OutletGroup[],
      isMultiOutlet: false,
    };
  }

  // Group items by outlet
  const outletMap = new Map<
    string,
    { outlet: (typeof cart.items)[0]['menuItem']['outlet']; items: (typeof cart.items) }
  >();
  for (const cartItem of cart.items) {
    const oid = cartItem.menuItem.outletId;
    if (!outletMap.has(oid)) outletMap.set(oid, { outlet: cartItem.menuItem.outlet, items: [] });
    outletMap.get(oid)!.items.push(cartItem);
  }

  const isMultiOutlet = outletMap.size > 1;
  const allIssues: CartIssue[] = [];
  const allItems: ReturnType<typeof buildLineItem>[] = [];
  const outletGroups: OutletGroup[] = [];

  for (const { outlet, items } of outletMap.values()) {
    const issues: CartIssue[] = [];
    const lineItems = items.map(({ menuItem, quantity }) => {
      const item = buildLineItem(menuItem, quantity, issues);
      return item;
    });
    allIssues.push(...issues);
    allItems.push(...lineItems);
    const groupSubtotal = lineItems.reduce((sum, i) => sum + i.lineTotalPaise, 0);
    const acceptingOrders = outlet.isActive && outlet.status === 'OPEN';
    outletGroups.push({
      outlet: {
        id: outlet.id,
        slug: outlet.slug,
        name: outlet.name,
        status: outlet.status,
        acceptingOrders,
      },
      items: lineItems,
      subtotalPaise: groupSubtotal,
      issues,
      canCheckout: issues.length === 0 && acceptingOrders,
      canSchedule: issues.length === 0 && outlet.isActive && outlet.status !== 'PAUSED',
    });
  }

  const subtotalPaise = allItems.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  const canCheckout = allIssues.length === 0 && outletGroups.every((g) => g.canCheckout);
  const canSchedule = allIssues.length === 0 && outletGroups.every((g) => g.canSchedule);

  return {
    /** null for multi-outlet carts; populated for single-outlet (backward compat). */
    outlet: isMultiOutlet ? null : (outletGroups[0]?.outlet ?? null),
    items: allItems,
    itemCount: allItems.reduce((sum, item) => sum + item.quantity, 0),
    subtotalPaise,
    totalPaise: subtotalPaise, // no fees or taxes (decision Q7)
    issues: allIssues,
    canCheckout,
    /**
     * Could be placed as a scheduled order (for a later pickup slot), even while the outlet
     * is closed right now. A paused outlet takes no new orders at all. Slots are checked on
     * their own (GET /outlets/:slug/slots) and again at checkout.
     */
    canSchedule,
    loyalty: loyalty(subtotalPaise),
    /** Per-outlet breakdown. Length 1 for single-outlet, >1 for multi-outlet. */
    outletGroups,
    isMultiOutlet,
  };
}

type CartIssue = {
  menuItemId: string;
  name: string;
  reason: CartIssueReason;
  available?: number;
};

type OutletGroup = {
  outlet: { id: string; slug: string; name: string; status: string; acceptingOrders: boolean };
  items: ReturnType<typeof buildLineItem>[];
  subtotalPaise: number;
  issues: CartIssue[];
  canCheckout: boolean;
  canSchedule: boolean;
};

function buildLineItem(
  menuItem: {
    id: string;
    name: string;
    dietary: string | null;
    pricePaise: number;
    isActive: boolean;
    isAvailable: boolean;
    stockQuantity: number | null;
    trackInventory: boolean;
    lowStockThreshold: number;
    category: { isActive: boolean };
  },
  quantity: number,
  issues: CartIssue[],
) {
  const onMenu = menuItem.isActive && menuItem.category.isActive;
  const orderable = onMenu && hasStockFor(menuItem, quantity);
  if (!orderable) {
    issues.push({
      menuItemId: menuItem.id,
      name: menuItem.name,
      reason: !onMenu ? 'NO_LONGER_ON_MENU' : inStock(menuItem) ? 'NOT_ENOUGH_STOCK' : 'SOLD_OUT',
      ...(onMenu && inStock(menuItem) && { available: menuItem.stockQuantity ?? 0 }),
    });
  }
  return {
    menuItemId: menuItem.id,
    name: menuItem.name,
    dietary: menuItem.dietary,
    unitPricePaise: menuItem.pricePaise,
    quantity,
    lineTotalPaise: menuItem.pricePaise * quantity,
    isOrderable: orderable,
    stockStatus: stockStatus(menuItem),
  };
}

export type CartView = Awaited<ReturnType<typeof getCartView>>;

/**
 * Creates the user's cart if it doesn't exist. A single INSERT … ON CONFLICT DO NOTHING,
 * so simultaneous first requests can't collide on the unique userId (an upsert can).
 */
async function ensureCart(tx: DbClient, userId: string) {
  await tx.$executeRaw`
    INSERT INTO "Cart" ("id", "userId", "createdAt", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${userId}::uuid, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    ON CONFLICT ("userId") DO NOTHING`;
}

/** Locks the user's cart row for the rest of the transaction (serialises cart changes and checkout). */
export async function lockCart(tx: DbClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "Cart" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
}

/** Recomputes cart.outletId based on current cart items (null if empty or multi-outlet). */
async function syncCartOutletId(tx: DbClient, cartId: string): Promise<void> {
  const outlets = await tx.menuItem.findMany({
    where: { cartItems: { some: { cartId } } },
    select: { outletId: true },
    distinct: ['outletId'],
  });
  const outletId = outlets.length === 1 ? outlets[0]!.outletId : null;
  await tx.cart.update({ where: { id: cartId }, data: { outletId } });
}

export async function addItem(
  db: Database,
  userId: string,
  input: { menuItemId: string; quantity: number; replaceCart: boolean },
) {
  await db.$transaction(async (tx) => {
    const menuItem = await tx.menuItem.findFirst({
      where: {
        id: input.menuItemId,
        isActive: true,
        category: { isActive: true },
        outlet: { isActive: true },
      },
      include: { outlet: true },
    });
    if (!menuItem) throw notFound('This item is not on the menu.');
    if (!inStock(menuItem)) {
      throw new AppError(409, 'ITEM_UNAVAILABLE', `${menuItem.name} is sold out right now.`);
    }
    if (menuItem.outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${menuItem.outlet.name} isn't taking orders right now.`,
      );
    }

    await ensureCart(tx, userId);
    await lockCart(tx, userId);
    const cart = await tx.cart.findUniqueOrThrow({
      where: { userId },
      include: { items: true },
    });

    if (input.replaceCart && cart.items.length > 0) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      cart.items = [];
    }

    const existing = cart.items.find((i) => i.menuItemId === menuItem.id);
    const wanted = (existing?.quantity ?? 0) + input.quantity;
    if (!hasStockFor(menuItem, wanted)) throw notEnough(menuItem.name, menuItem.stockQuantity ?? 0);
    if (existing) {
      const quantity = existing.quantity + input.quantity;
      if (quantity > MAX_QUANTITY) {
        throw new AppError(
          409,
          'QUANTITY_LIMIT',
          `You can order up to ${MAX_QUANTITY} of each item.`,
        );
      }
      await tx.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    } else {
      if (cart.items.length >= MAX_DISTINCT_ITEMS) {
        throw new AppError(
          409,
          'CART_FULL',
          `A cart can hold up to ${MAX_DISTINCT_ITEMS} different items.`,
        );
      }
      await tx.cartItem.create({
        data: { cartId: cart.id, menuItemId: menuItem.id, quantity: input.quantity },
      });
    }

    await syncCartOutletId(tx, cart.id);
  });
  return getCartView(db, userId);
}

export async function setQuantity(
  db: Database,
  userId: string,
  menuItemId: string,
  quantity: number,
) {
  const cart = await db.cart.findUnique({ where: { userId } });
  const line =
    cart &&
    (await db.cartItem.findUnique({
      where: { cartId_menuItemId: { cartId: cart.id, menuItemId } },
    }));
  if (!line) throw notFound('That item is not in your cart.');
  const menuItem = await db.menuItem.findUniqueOrThrow({ where: { id: menuItemId } });
  if (quantity > line.quantity && !hasStockFor(menuItem, quantity)) {
    throw notEnough(menuItem.name, menuItem.stockQuantity ?? 0);
  }
  await db.cartItem.update({ where: { id: line.id }, data: { quantity } });
  return getCartView(db, userId);
}

export async function removeItem(db: Database, userId: string, menuItemId: string) {
  await db.$transaction(async (tx) => {
    const cart = await tx.cart.findUnique({ where: { userId } });
    if (!cart) throw notFound('That item is not in your cart.');
    const { count } = await tx.cartItem.deleteMany({ where: { cartId: cart.id, menuItemId } });
    if (count === 0) throw notFound('That item is not in your cart.');
    await syncCartOutletId(tx, cart.id);
  });
  return getCartView(db, userId);
}

export async function clearCart(db: DbClient, userId: string) {
  const cart = await db.cart.findUnique({ where: { userId } });
  if (cart) {
    await db.cartItem.deleteMany({ where: { cartId: cart.id } });
    await db.cart.update({ where: { id: cart.id }, data: { outletId: null } });
  }
}

/**
 * Adds several dishes at once (a Surprise Meal combo) in ONE transaction: every dish is
 * re-checked against the live menu and the total against what the student saw, the combo
 * must come from one outlet, and nothing is added unless everything is valid. Repeating
 * the same idempotency key (double-click, retry) adds nothing more.
 */
export async function addCombo(
  db: Database,
  userId: string,
  input: {
    items: { menuItemId: string; quantity: number }[];
    expectedTotalPaise: number;
    replaceCart: boolean;
    idempotencyKey: string;
  },
) {
  const added = await db.$transaction(async (tx) => {
    const ids = input.items.map((i) => i.menuItemId);
    const menuItems = await tx.menuItem.findMany({
      where: { id: { in: ids } },
      include: { outlet: true, category: true },
    });
    const byId = new Map(menuItems.map((m) => [m.id, m]));
    const problems = input.items
      .map(({ menuItemId }) => byId.get(menuItemId) ?? { id: menuItemId, name: null })
      .filter(
        (m) =>
          !('isActive' in m) ||
          !m.isActive ||
          !inStock(m) ||
          !m.category.isActive ||
          !m.outlet.isActive,
      )
      .map((m) => ({ menuItemId: m.id, name: m.name }));
    if (problems.length > 0) {
      throw new AppError(
        409,
        'ITEMS_UNAVAILABLE',
        'Some dishes in this combo are no longer available.',
        { items: problems },
      );
    }
    const dishes = ids.map((id) => byId.get(id)!);
    const outlets = new Set(dishes.map((d) => d.outletId));
    if (outlets.size !== 1) {
      throw new AppError(400, 'MIXED_OUTLETS', 'A combo must come from one outlet.');
    }
    const outlet = dishes[0]!.outlet;
    if (outlet.status !== 'OPEN') {
      throw new AppError(
        409,
        'OUTLET_NOT_ACCEPTING',
        `${outlet.name} isn't taking orders right now.`,
      );
    }
    const totalPaise = input.items.reduce(
      (sum, { menuItemId, quantity }) => sum + byId.get(menuItemId)!.pricePaise * quantity,
      0,
    );
    if (totalPaise !== input.expectedTotalPaise) {
      throw new AppError(409, 'PRICE_CHANGED', 'Prices changed since this combo was made.', {
        totalPaise,
        items: dishes.map((d) => ({ menuItemId: d.id, pricePaise: d.pricePaise })),
      });
    }

    await ensureCart(tx, userId);
    await lockCart(tx, userId);
    const cart = await tx.cart.findUniqueOrThrow({
      where: { userId },
      include: { items: true },
    });
    // The same combo submitted again (after the first one committed): already added.
    if (cart.lastComboKey === input.idempotencyKey) return false;

    if (input.replaceCart && cart.items.length > 0) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      cart.items = [];
    }

    let distinct = cart.items.length;
    for (const { menuItemId, quantity } of input.items) {
      const existing = cart.items.find((i) => i.menuItemId === menuItemId);
      const dish = byId.get(menuItemId)!;
      if (!hasStockFor(dish, (existing?.quantity ?? 0) + quantity)) {
        throw notEnough(dish.name, dish.stockQuantity ?? 0);
      }
      if (existing) {
        if (existing.quantity + quantity > MAX_QUANTITY) {
          throw new AppError(
            409,
            'QUANTITY_LIMIT',
            `You can order up to ${MAX_QUANTITY} of each item.`,
          );
        }
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + quantity },
        });
      } else {
        distinct += 1;
        if (distinct > MAX_DISTINCT_ITEMS) {
          throw new AppError(
            409,
            'CART_FULL',
            `A cart can hold up to ${MAX_DISTINCT_ITEMS} different items.`,
          );
        }
        await tx.cartItem.create({ data: { cartId: cart.id, menuItemId, quantity } });
      }
    }

    await syncCartOutletId(tx, cart.id);
    await tx.cart.update({ where: { id: cart.id }, data: { lastComboKey: input.idempotencyKey } });
    return true;
  });
  return { cart: await getCartView(db, userId), added };
}
