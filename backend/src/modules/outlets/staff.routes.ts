import { Router, type Request } from 'express';
import type { Database } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import type { StaffRole } from '../../generated/prisma/enums.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { setSoldOut } from '../inventory/inventory.service.js';
import {
  availabilityBody,
  createCategoryBody,
  createItemBody,
  outletStatusBody,
  updateCategoryBody,
  updateIntelligenceBody,
  updateItemBody,
  uuidParam,
} from './outlets.schema.js';
import {
  toCategoryAdmin,
  toMenuItemAdmin,
  toOutletAdmin,
  toOutletSummary,
} from './outlets.serializer.js';

const duplicateName = () =>
  new AppError(409, 'DUPLICATE_NAME', 'Something with this name already exists at this outlet.');

/** Rewrites unique-constraint failures as a friendly 409. */
async function guardDuplicates<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateName();
    throw error;
  }
}

function idParam(req: Request, name: string): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const actorOf = (req: Request) => ({ type: 'USER' as const, userId: req.auth!.user.id });

/**
 * Outlet operations for assigned staff. Every route under /:outletId checks the
 * user's live role AND their assignment to that outlet, and every lookup is
 * scoped by outletId so IDs from another outlet resolve to 404.
 */
export function staffOutletsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireAuth);

  const manager = requireOutletRole(db, 'MANAGER');
  const managerOrPos = requireOutletRole(db, 'MANAGER', 'POS');

  async function findCategory(outletId: string, categoryId: string) {
    const category = await db.menuCategory.findFirst({ where: { id: categoryId, outletId } });
    if (!category) throw notFound('Category not found');
    return category;
  }

  async function findItem(outletId: string, itemId: string) {
    const item = await db.menuItem.findFirst({ where: { id: itemId, outletId } });
    if (!item) throw notFound('Menu item not found');
    return item;
  }

  /** The outlets this user may operate, with the roles they hold there. */
  router.get('/', async (req, res) => {
    const activeStaffRoles = req.auth!.user.roles.filter(
      (role): role is StaffRole => role === 'MANAGER' || role === 'POS',
    );
    const assignments = await db.staffAssignment.findMany({
      where: {
        userId: req.auth!.user.id,
        role: { in: activeStaffRoles },
        outlet: { isActive: true },
      },
      include: { outlet: true },
      orderBy: { outlet: { name: 'asc' } },
    });
    const byOutlet = new Map<
      string,
      { outlet: ReturnType<typeof toOutletSummary>; roles: StaffRole[] }
    >();
    for (const a of assignments) {
      const entry = byOutlet.get(a.outletId) ?? { outlet: toOutletSummary(a.outlet), roles: [] };
      entry.roles.push(a.role);
      byOutlet.set(a.outletId, entry);
    }
    res.json({ outlets: [...byOutlet.values()] });
  });

  /** Full menu including deactivated categories/items, for staff. */
  router.get('/:outletId/menu', managerOrPos, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const [outlet, categories, items] = await Promise.all([
      db.outlet.findUniqueOrThrow({ where: { id: outletId } }),
      db.menuCategory.findMany({
        where: { outletId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      db.menuItem.findMany({
        where: { outletId },
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);
    res.json({
      outlet: toOutletAdmin(outlet),
      categories: categories.map(toCategoryAdmin),
      items: items.map(toMenuItemAdmin),
    });
  });

  /** Open / pause / close the outlet. Managers only. */
  router.patch('/:outletId/status', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const { status } = outletStatusBody.parse(req.body);
    const outlet = await db.$transaction(async (tx) => {
      const before = await tx.outlet.findUniqueOrThrow({ where: { id: outletId } });
      const after = await tx.outlet.update({ where: { id: outletId }, data: { status } });
      if (before.status !== status) {
        await recordAudit(tx, {
          actor: actorOf(req),
          action: 'OUTLET_STATUS_CHANGED',
          entityType: 'Outlet',
          entityId: outletId,
          metadata: { from: before.status, to: status },
        });
      }
      return after;
    });
    res.json({ outlet: toOutletAdmin(outlet) });
  });

  router.post('/:outletId/categories', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = createCategoryBody.parse(req.body);
    const category = await guardDuplicates(() =>
      db.menuCategory.create({
        data: { outletId, name: body.name, sortOrder: body.sortOrder ?? 0 },
      }),
    );
    res.status(201).json({ category: toCategoryAdmin(category) });
  });

  router.patch('/:outletId/categories/:categoryId', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const existing = await findCategory(outletId, idParam(req, 'categoryId'));
    const body = updateCategoryBody.parse(req.body);
    const category = await guardDuplicates(() =>
      db.menuCategory.update({ where: { id: existing.id }, data: body }),
    );
    res.json({ category: toCategoryAdmin(category) });
  });

  router.post('/:outletId/items', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = createItemBody.parse(req.body);
    await findCategory(outletId, body.categoryId);
    const item = await guardDuplicates(() =>
      db.$transaction(async (tx) => {
        const created = await tx.menuItem.create({ data: { ...body, outletId } });
        await recordAudit(tx, {
          actor: actorOf(req),
          action: 'MENU_ITEM_CREATED',
          entityType: 'MenuItem',
          entityId: created.id,
          metadata: { outletId, name: created.name, pricePaise: created.pricePaise },
        });
        return created;
      }),
    );
    res.status(201).json({ item: toMenuItemAdmin(item) });
  });

  router.patch('/:outletId/items/:itemId', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const existing = await findItem(outletId, idParam(req, 'itemId'));
    const body = updateItemBody.parse(req.body);
    if (body.categoryId) await findCategory(outletId, body.categoryId);

    const item = await guardDuplicates(() =>
      db.$transaction(async (tx) => {
        const updated = await tx.menuItem.update({ where: { id: existing.id }, data: body });
        const actor = actorOf(req);
        if (body.pricePaise !== undefined && body.pricePaise !== existing.pricePaise) {
          await recordAudit(tx, {
            actor,
            action: 'MENU_ITEM_PRICE_CHANGED',
            entityType: 'MenuItem',
            entityId: existing.id,
            metadata: { outletId, fromPaise: existing.pricePaise, toPaise: body.pricePaise },
          });
        }
        if (
          body.fulfillmentType !== undefined &&
          body.fulfillmentType !== existing.fulfillmentType
        ) {
          // Applies to future orders only: each order keeps the classification it was placed with.
          await recordAudit(tx, {
            actor,
            action: 'MENU_ITEM_CLASSIFICATION_CHANGED',
            entityType: 'MenuItem',
            entityId: existing.id,
            metadata: { outletId, from: existing.fulfillmentType, to: body.fulfillmentType },
          });
        }
        if (body.isAvailable !== undefined && body.isAvailable !== existing.isAvailable) {
          await tx.stockAdjustment.create({
            data: {
              menuItemId: existing.id,
              outletId,
              type: body.isAvailable ? 'MARKED_AVAILABLE' : 'MARKED_SOLD_OUT',
              quantityChange: 0,
              previousQuantity: existing.stockQuantity,
              resultingQuantity: existing.stockQuantity,
              actorUserId: req.auth!.user.id,
              actorRole: 'MANAGER',
            },
          });
        }
        if (body.isActive !== undefined && body.isActive !== existing.isActive) {
          await recordAudit(tx, {
            actor,
            action: body.isActive ? 'MENU_ITEM_REACTIVATED' : 'MENU_ITEM_DEACTIVATED',
            entityType: 'MenuItem',
            entityId: existing.id,
            metadata: { outletId, name: existing.name },
          });
        }
        return updated;
      }),
    );
    res.json({ item: toMenuItemAdmin(item) });
  });

  /**
   * PATCH /:outletId/intelligence — update crowd level, queue length, seats,
   * rating and specialty items. Managers only.
   *
   * These values are MANUALLY maintained. They do not update automatically and
   * do not reflect live real-time data unless the manager has just set them.
   */
  router.patch('/:outletId/intelligence', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = updateIntelligenceBody.parse(req.body);
    const outlet = await db.outlet.update({
      where: { id: outletId },
      data: { ...body, intelligenceUpdatedAt: new Date() },
    });
    res.json({ outlet: toOutletAdmin(outlet) });
  });

  /** Mark an item sold out / back in stock. Managers and POS staff. */
  router.patch('/:outletId/items/:itemId/availability', managerOrPos, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const existing = await findItem(outletId, idParam(req, 'itemId'));
    const { isAvailable } = availabilityBody.parse(req.body);
    const roles = req.auth!.user.roles;
    const assignments = await db.staffAssignment.findMany({
      where: { userId: req.auth!.user.id, outletId },
      select: { role: true },
    });
    const pos = assignments.some((a) => a.role === 'POS') && roles.includes('POS');
    // Marked sold out stays sold out until staff restore it — restocking never undoes it.
    await setSoldOut(db, {
      outletId,
      itemId: existing.id,
      soldOut: !isAvailable,
      actor: { userId: req.auth!.user.id, role: pos ? 'POS' : 'MANAGER' },
    });
    realtime.stockChanged(outletId, [existing.id]);
    const item = await db.menuItem.findUniqueOrThrow({ where: { id: existing.id } });
    res.json({ item: toMenuItemAdmin(item) });
  });

  return router;
}
