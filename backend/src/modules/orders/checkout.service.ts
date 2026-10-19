import type { Database } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import type { FoodFulfillment, PaymentMethod } from '../../generated/prisma/enums.js';
import { lockCart } from '../cart/cart.service.js';
import { debitBalance, ensureWallet } from '../wallet/wallet.service.js';
import { formatPickupCode, istDay, nextPickupNumber } from './pickup.js';
import { redeemForOrder } from '../loyalty/loyalty.service.js';
import { deductForOrder } from '../inventory/inventory.service.js';
import { inStock } from '../inventory/stock.js';
import { assertSlotBookable, loadOutletWithHours } from '../scheduling/scheduling.service.js';
import { feeFor } from '../scheduling/scheduling.rules.js';
import { notify } from '../notifications/notifications.service.js';
import { placedNotice } from '../notifications/order-notices.js';
import { maxRedeemablePoints, pointsToPaise } from '../loyalty/loyalty.rules.js';
import { orderInclude, toOrder } from './orders.serializer.js';
import { claimOrderCapacity } from '../capacity/capacity.service.js';
import { ORDER_CAPACITY_PER_WINDOW } from '../capacity/capacity.rules.js';
import { monthBoundsUtc, getMonthlySpend } from '../budget/budget.service.js';

export interface CheckoutInput {
  userId: string;
  paymentMethod: PaymentMethod;
  /** The total the student saw. If prices changed since, checkout stops and asks them to confirm. */
  expectedTotalPaise: number;
  /** Loyalty points to spend on this order (1 point = ₹1). */
  pointsToRedeem?: number;
  /** A pickup slot start for a scheduled order; absent/null = order now (the original flow). */
  scheduledFor?: Date | null;
  idempotencyKey: string;
  /** Orders per outlet per rolling window. Only end-to-end test setups change it (see env.ts). */
  capacityLimit?: number;
}

async function findByKey(db: Database, userId: string, idempotencyKey: string) {
  const order = await db.order.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    include: orderInclude,
  });
  return order && toOrder(order);
}

async function findByBatchKey(db: Database, userId: string, batchKey: string) {
  const orders = await db.order.findMany({
    where: { userId, batchKey },
    include: orderInclude,
    orderBy: { placedAt: 'asc' },
  });
  return orders.map(toOrder);
}

/**
 * Turns the student's cart into one order per outlet in ONE database transaction:
 * re-validate everything → price on the server → take a pickup number →
 * create the order(s) → (wallet) debit atomically → empty the cart.
 * If any step fails, nothing is saved: no order, no debit, cart unchanged.
 *
 * Single-outlet carts produce one order (fully backward-compatible).
 * Multi-outlet carts produce one order per outlet, all linked by batchKey.
 */
export async function checkout(db: Database, input: CheckoutInput) {
  const { userId, paymentMethod, expectedTotalPaise, idempotencyKey } = input;
  const batchKey = idempotencyKey;
  const pointsToRedeem = input.pointsToRedeem ?? 0;
  const scheduledFor = input.scheduledFor ?? null;
  const timing = scheduledFor ? 'SCHEDULED' : 'IMMEDIATE';

  // Retried request: return already-placed orders for this batch.
  const existingBatch = await findByBatchKey(db, userId, batchKey);
  if (existingBatch.length > 0) {
    return { order: existingBatch[0]!, orders: existingBatch, created: false };
  }
  // Backward compat: legacy single-outlet orders don't have batchKey set.
  const legacySingle = await findByKey(db, userId, idempotencyKey);
  if (legacySingle) return { order: legacySingle, orders: [legacySingle], created: false };

  try {
    const outcome = await db.$transaction(async (tx) => {
      // Serialise checkouts of this cart.
      await lockCart(tx, userId);
      // In-transaction dedup: check for races.
      const dupInBatch = await tx.order.findFirst({
        where: { userId, batchKey },
        select: { id: true },
      });
      if (dupInBatch) {
        const dups = await tx.order.findMany({
          where: { userId, batchKey },
          select: { id: true },
          orderBy: { placedAt: 'asc' },
        });
        return { orderIds: dups.map((d) => d.id), created: false };
      }
      // Also check by idempotencyKey directly (legacy single-outlet race).
      const dupLegacy = await tx.order.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: { id: true },
      });
      if (dupLegacy) return { orderIds: [dupLegacy.id], created: false };

      const cart = await tx.cart.findUnique({
        where: { userId },
        include: {
          items: {
            include: { menuItem: { include: { category: true, outlet: true } } },
          },
        },
      });
      if (!cart || cart.items.length === 0) {
        throw new AppError(409, 'CART_EMPTY', 'Your cart is empty.');
      }

      // Group items by outlet (preserves insertion order for predictable first/last).
      const outletGroupMap = new Map<
        string,
        Array<(typeof cart.items)[0]>
      >();
      for (const item of cart.items) {
        const oid = item.menuItem.outletId;
        if (!outletGroupMap.has(oid)) outletGroupMap.set(oid, []);
        outletGroupMap.get(oid)!.push(item);
      }
      const isMultiOutlet = outletGroupMap.size > 1;

      // ── Validate each outlet ──────────────────────────────────────────────
      type CartItem = (typeof cart.items)[0];
      type GroupData = {
        outlet: CartItem['menuItem']['outlet'];
        cartItems: CartItem[];
        lines: {
          menuItemId: string;
          name: string;
          unitPricePaise: number;
          quantity: number;
          lineTotalPaise: number;
          fulfillmentType: FoodFulfillment | null;
        }[];
        subtotalPaise: number;
        /** Per-order idempotency key: batchKey for single-outlet, batchKey:outletId for multi. */
        orderIdempotencyKey: string;
        pointsRedeemed: number;
        pointsDiscountPaise: number;
        scheduledFeePaise: number;
        totalPaise: number;
      };

      const groups: GroupData[] = [];
      for (const [outletId, items] of outletGroupMap) {
        const outlet = items[0]!.menuItem.outlet;
        if (scheduledFor) {
          await assertSlotBookable(
            tx,
            await loadOutletWithHours(tx, { id: outlet.id }),
            scheduledFor,
          );
        } else if (!outlet.isActive || outlet.status !== 'OPEN') {
          throw new AppError(
            409,
            'OUTLET_NOT_ACCEPTING',
            `${outlet.name} isn't taking orders right now.`,
          );
        }

        const problems = items
          .filter(
            ({ menuItem }) =>
              !menuItem.isActive ||
              !menuItem.category.isActive ||
              !inStock(menuItem) ||
              menuItem.outletId !== outlet.id,
          )
          .map(({ menuItem }) => ({ menuItemId: menuItem.id, name: menuItem.name }));
        if (problems.length > 0) {
          throw new AppError(
            409,
            'ITEMS_UNAVAILABLE',
            'Some items in your cart are no longer available. Remove them to continue.',
            { items: problems },
          );
        }

        const lines = items.map(({ menuItem, quantity }) => ({
          menuItemId: menuItem.id,
          name: menuItem.name,
          unitPricePaise: menuItem.pricePaise,
          quantity,
          lineTotalPaise: menuItem.pricePaise * quantity,
          fulfillmentType: menuItem.fulfillmentType,
        }));
        const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

        groups.push({
          outlet,
          cartItems: items,
          lines,
          subtotalPaise,
          orderIdempotencyKey: isMultiOutlet ? `${batchKey}:${outletId}` : batchKey,
          // Filled in below after pro-rata calculation
          pointsRedeemed: 0,
          pointsDiscountPaise: 0,
          scheduledFeePaise: 0,
          totalPaise: 0,
        });
      }

      const totalSubtotalPaise = groups.reduce((sum, g) => sum + g.subtotalPaise, 0);

      // ── Points validation ─────────────────────────────────────────────────
      if (pointsToRedeem > maxRedeemablePoints(totalSubtotalPaise, Number.MAX_SAFE_INTEGER)) {
        throw new AppError(
          400,
          'POINTS_EXCEED_ORDER',
          'You cannot use that many points on this order.',
          { maxPoints: maxRedeemablePoints(totalSubtotalPaise, Number.MAX_SAFE_INTEGER) },
        );
      }
      const totalPointsDiscountPaise = pointsToPaise(pointsToRedeem);

      // ── Pro-rata points distribution across outlet groups ─────────────────
      let remainingDiscount = totalPointsDiscountPaise;
      let remainingPoints = pointsToRedeem;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i]!;
        const isLast = i === groups.length - 1;
        // First group gets the scheduled-order fee (if any).
        g.scheduledFeePaise = i === 0 ? feeFor(timing) : 0;
        if (isLast) {
          g.pointsDiscountPaise = remainingDiscount;
          g.pointsRedeemed = remainingPoints;
        } else {
          g.pointsDiscountPaise = Math.round(
            totalPointsDiscountPaise * (g.subtotalPaise / totalSubtotalPaise),
          );
          g.pointsRedeemed = Math.round(
            pointsToRedeem * (g.subtotalPaise / totalSubtotalPaise),
          );
          remainingDiscount -= g.pointsDiscountPaise;
          remainingPoints -= g.pointsRedeemed;
        }
        g.totalPaise = g.subtotalPaise - g.pointsDiscountPaise + g.scheduledFeePaise;
      }

      const grandTotalPaise = groups.reduce((sum, g) => sum + g.totalPaise, 0);
      if (grandTotalPaise !== expectedTotalPaise) {
        throw new AppError(
          409,
          'PRICE_CHANGED',
          'Prices changed since you last looked. Please review your order.',
          { totalPaise: grandTotalPaise },
        );
      }

      // ── Budget cap ────────────────────────────────────────────────────────
      const budget = await tx.spendingBudget.findUnique({ where: { userId } });
      if (budget) {
        const now = new Date();
        const { start, end } = monthBoundsUtc(budget.timezone, now);
        const spentPaise = await getMonthlySpend(tx, userId, start, end);
        if (spentPaise + grandTotalPaise > budget.limitPaise) {
          throw new AppError(
            409,
            'BUDGET_EXCEEDED',
            'This order would exceed your monthly spending budget.',
            {
              limitPaise: budget.limitPaise,
              spentPaise,
              remainingPaise: Math.max(0, budget.limitPaise - spentPaise),
              orderTotalPaise: grandTotalPaise,
            },
          );
        }
      }

      // ── Create one order per outlet ───────────────────────────────────────
      const orderIds: string[] = [];
      const day = istDay(scheduledFor ?? undefined);

      for (const g of groups) {
        const pickupNumber = await nextPickupNumber(tx, g.outlet.id, day);
        const order = await tx.order.create({
          data: {
            userId,
            outletId: g.outlet.id,
            pickupDay: new Date(`${day}T00:00:00Z`),
            pickupNumber,
            pickupCode: formatPickupCode(g.outlet.name, pickupNumber),
            status: 'PLACED',
            paymentMethod,
            paymentStatus: paymentMethod === 'WALLET' ? 'PAID' : 'PENDING_COUNTER',
            subtotalPaise: g.subtotalPaise,
            pointsRedeemed: g.pointsRedeemed,
            pointsDiscountPaise: g.pointsDiscountPaise,
            timing,
            scheduledFor,
            scheduledFeePaise: g.scheduledFeePaise,
            totalPaise: g.totalPaise,
            idempotencyKey: g.orderIdempotencyKey,
            batchKey,
            items: { create: g.lines },
            history: { create: { toStatus: 'PLACED', actorUserId: userId, actorRole: 'STUDENT' } },
          },
        });
        orderIds.push(order.id);

        // Capacity check per outlet — full → 429 rolls back everything.
        await claimOrderCapacity(tx, {
          outletId: g.outlet.id,
          orderId: order.id,
          limit: input.capacityLimit ?? ORDER_CAPACITY_PER_WINDOW,
        });

        await notify(
          tx,
          placedNotice({
            id: order.id,
            userId,
            pickupCode: order.pickupCode,
            outletName: g.outlet.name,
            scheduledFor,
          }),
        );

        // Counted items: take the stock now, atomically.
        await deductForOrder(tx, {
          orderId: order.id,
          lines: g.lines,
          items: g.cartItems.map(({ menuItem }) => menuItem),
          actor: { userId, role: 'STUDENT' },
        });
      }

      // ── Points redemption (one transaction per order) ─────────────────────
      if (pointsToRedeem > 0) {
        const wallet = await ensureWallet(tx, userId);
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i]!;
          if (g.pointsRedeemed === 0) continue;
          await redeemForOrder(tx, {
            walletId: wallet.id,
            orderId: orderIds[i]!,
            points: g.pointsRedeemed,
            label: `order at ${g.outlet.name}`,
            isSimulated: true,
          });
        }
      }

      // ── Wallet debit (one transaction per order) ──────────────────────────
      if (paymentMethod === 'WALLET') {
        const wallet = await ensureWallet(tx, userId);
        // Snapshot balance before any debits so error details are accurate even when
        // failure occurs on the 2nd+ outlet (earlier debits are still rolled back).
        const preDebitBalance = wallet.balancePaise;
        const now = new Date();
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i]!;
          const orderId = orderIds[i]!;
          const balanceAfter = await debitBalance(tx, wallet.id, g.totalPaise);
          if (balanceAfter === null) {
            throw new AppError(
              409,
              'INSUFFICIENT_BALANCE',
              'Your wallet balance is too low for this order.',
              {
                balancePaise: preDebitBalance,
                totalPaise: grandTotalPaise,
                shortfallPaise: grandTotalPaise - preDebitBalance,
              },
            );
          }
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: 'ORDER_DEBIT',
              direction: 'DEBIT',
              amountPaise: g.totalPaise,
              balanceAfterPaise: balanceAfter,
              status: 'COMPLETED',
              completedAt: now,
              orderId,
              idempotencyKey: `order-debit:${orderId}`,
              description: `Order ${groups[i]!.lines.length > 0 ? `at ${g.outlet.name}` : ''}`,
              isSimulated: true,
            },
          });
        }
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { outletId: null } });
      return { orderIds, created: true };
    });

    const orders = await db.order.findMany({
      where: { id: { in: outcome.orderIds } },
      include: orderInclude,
      orderBy: { placedAt: 'asc' },
    });
    const serialized = orders.map(toOrder);
    return { order: serialized[0]!, orders: serialized, created: outcome.created };
  } catch (error) {
    // Same key submitted twice concurrently: the other request won.
    if (isUniqueViolation(error)) {
      const winner = await findByBatchKey(db, userId, batchKey);
      if (winner.length > 0) return { order: winner[0]!, orders: winner, created: false };
      const legacyWinner = await findByKey(db, userId, idempotencyKey);
      if (legacyWinner) return { order: legacyWinner, orders: [legacyWinner], created: false };
    }
    throw error;
  }
}
