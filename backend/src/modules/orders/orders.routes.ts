import { Router } from 'express';
import { deliverSoon } from '../notifications/deliver.js';
import { afterOrderChange } from '../kitchen/kitchen.service.js';
import { decideAutoAccept } from '../autoaccept/autoaccept.service.js';
import { notifyOutletStaff } from '../notifications/notifications.service.js';
import { ORDER_CAPACITY_WINDOW_SECONDS } from '../capacity/capacity.rules.js';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { requireIdempotencyKey } from '../../lib/idempotency.js';
import { requireRole } from '../../middleware/auth.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { checkout } from './checkout.service.js';
import { rescheduleOrder } from '../scheduling/scheduling.service.js';
import { transitionOrder } from './transitions.js';
import type { Env } from '../../config/env.js';
import {
  ACTIVE_STATUSES,
  decodeOrderCursor,
  encodeOrderCursor,
  FINISHED_STATUSES,
  orderInclude,
  toOrder,
  toOrderSummary,
} from './orders.serializer.js';

const checkoutBody = z
  .object({
    paymentMethod: z.enum(['WALLET', 'COUNTER']),
    expectedTotalPaise: z.number().int().positive(),
    /** Loyalty points to spend (1 point = ₹1). The server re-checks the order and balance. */
    pointsToRedeem: z.number().int().min(0).max(100_000).default(0),
    /** A pickup slot (ISO instant with offset) for a scheduled order; omit to order now. */
    scheduledFor: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .nullable()
      .optional(),
  })
  .strict();

const listQuery = z.object({
  view: z.enum(['active', 'past']).default('active'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();
const rescheduleBody = z
  .object({ scheduledFor: z.iso.datetime({ offset: true }).transform((v) => new Date(v)) })
  .strict();

function orderIdParam(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound('Order not found');
  return parsed.data;
}

/** /api/v1/orders — the signed-in student's own orders. */
export function ordersRouter(
  db: Database,
  realtime: RealtimePublisher,
  config: Pick<Env, 'ORDER_CAPACITY_PER_WINDOW'>,
) {
  const router = Router();
  // FACULTY, STAFF, and EXECUTIVE personas carry ordering permissions alongside STUDENT.
  // GUEST is intentionally excluded: guests may browse menus but not place orders.
  router.use(requireRole('STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'));

  router.post('/', async (req, res) => {
    const idempotencyKey = requireIdempotencyKey(req);
    const body = checkoutBody.parse(req.body);
    const userId = req.auth!.user.id;
    let result;
    try {
      result = await checkout(db, {
        ...body,
        userId,
        idempotencyKey,
        capacityLimit: config.ORDER_CAPACITY_PER_WINDOW,
      });
    } catch (err) {
      // The checkout rolled back; tell the outlet's staff once per capacity window.
      if (err instanceof AppError && err.code === 'ORDER_CAPACITY_FULL') {
        void notifyCapacityFull(db, userId).catch(() => undefined);
      }
      throw err;
    }
    const { order, orders, created } = result;
    if (created) {
      deliverSoon(db, realtime);
      for (const o of orders) {
        await afterOrderChange(db, realtime, o.outlet.id);
        await decideAutoAccept(db, realtime, o.id).catch(() => null);
        realtime.orderCreated(o, userId);
        realtime.stockChanged(
          o.outlet.id,
          o.items.map((i) => i.menuItemId),
        );
      }
      if (order.paymentMethod === 'WALLET') realtime.walletUpdated(userId, 'ORDER_DEBIT');
    }
    res.status(created ? 201 : 200).json({ order, orders });
  });

  /** Order history: "active" (in progress) or "past" (finished), newest first. */
  router.get('/', async (req, res) => {
    const { view, limit, cursor } = listQuery.parse(req.query);
    const after = cursor ? decodeOrderCursor(cursor) : null;
    if (cursor && !after) throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
    const rows = await db.order.findMany({
      where: {
        userId: req.auth!.user.id,
        status: { in: [...(view === 'active' ? ACTIVE_STATUSES : FINISHED_STATUSES)] },
        ...(after && {
          OR: [
            { placedAt: { lt: after.placedAt } },
            { placedAt: after.placedAt, id: { lt: after.id } },
          ],
        }),
      },
      include: { outlet: true, items: true },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    res.json({
      orders: page.map(toOrderSummary),
      nextCursor: rows.length > limit ? encodeOrderCursor(page[page.length - 1]!) : null,
    });
  });

  /** One of the caller's own orders. Anyone else's order is indistinguishable from a missing one. */
  router.get('/:orderId', async (req, res) => {
    const order = await db.order.findFirst({
      where: { id: orderIdParam(req.params.orderId), userId: req.auth!.user.id },
      include: orderInclude,
    });
    if (!order) throw notFound('Order not found');
    res.json({ order: toOrder(order) });
  });

  /** Moves the student's own scheduled order to another valid slot (no extra fee). */
  router.post('/:orderId/reschedule', async (req, res) => {
    const { scheduledFor } = rescheduleBody.parse(req.body);
    const result = await rescheduleOrder(db, {
      userId: req.auth!.user.id,
      orderId: orderIdParam(req.params.orderId),
      scheduledFor,
    });
    if (result.changed) realtime.orderUpdated(result.order, result.ownerId);
    res.json({ order: result.order });
  });

  /** The user cancels their own order — allowed only while it is still PLACED. */
  router.post('/:orderId/cancel', async (req, res) => {
    const { reason } = cancelBody.parse(req.body ?? {});
    const userId = req.auth!.user.id;
    // Pass the subset of the user's roles that are ordering personas so the
    // transition rule table can decide who may cancel.
    const orderingPersonas = ['STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'] as const;
    const actorRoles = req.auth!.user.roles.filter((r): r is typeof orderingPersonas[number] =>
      (orderingPersonas as readonly string[]).includes(r),
    );
    const result = await transitionOrder(db, {
      orderId: orderIdParam(req.params.orderId),
      to: 'CANCELLED',
      reason,
      actorRoles: actorRoles.length > 0 ? actorRoles : ['STUDENT'],
      actorUserId: userId,
      scope: { userId },
    });
    realtime.orderUpdated(result.order, result.ownerId);
    deliverSoon(db, realtime);
    await afterOrderChange(db, realtime, result.order.outlet.id);
    if (result.refunded || result.pointsRestored) realtime.walletUpdated(result.ownerId, 'REFUND');
    for (const userId of result.groupRefundedUserIds) realtime.walletUpdated(userId, 'REFUND');
    if (result.stockRestored.length > 0)
      realtime.stockChanged(result.order.outlet.id, result.stockRestored);
    res.json({ order: result.order });
  });

  return router;
}

/** Capacity refused an order: one notice per outlet per capacity window for its staff. */
async function notifyCapacityFull(db: Database, userId: string) {
  const cart = await db.cart.findUnique({ where: { userId }, select: { outletId: true } });
  if (!cart?.outletId) return;
  const windowStart = Math.floor(Date.now() / (ORDER_CAPACITY_WINDOW_SECONDS * 1000));
  await notifyOutletStaff(db, cart.outletId, ['MANAGER', 'POS'], {
    type: 'STAFF_CAPACITY_FULL',
    title: 'Order capacity reached',
    body: 'Students are being asked to try again shortly: 10 orders were taken in the last 3 minutes.',
    link: '/pos',
    dedupeKey: `outlet:${cart.outletId}:CAPACITY_FULL:${windowStart}`,
  });
}
