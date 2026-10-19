import type { Database, DbClient } from '../../lib/prisma.js';
import type { Order } from '../../generated/prisma/client.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { OrderStatus, PaymentStatus, Role } from '../../generated/prisma/enums.js';
import { refundToBalance } from '../wallet/wallet.service.js';
import { restoreForOrder } from '../loyalty/loyalty.service.js';
import { restoreForOrder as restoreStockForOrder } from '../inventory/inventory.service.js';
import { refundablePaise } from '../scheduling/scheduling.rules.js';
import { refundGroupOrder } from '../groups/groups.service.js';
import { formatSlot } from '../scheduling/slots.js';
import { orderInclude, toOrder } from './orders.serializer.js';
import { issueCredential, revokeCredentials } from '../pickup/pickup.service.js';
import { notifyOrderStatus } from '../notifications/order-notices.js';
import { recordReadyObservation } from '../kitchen/kitchen.service.js';

/** Roles that may appear as actors in order transitions. */
type ActorRole = Extract<Role, 'STUDENT' | 'FACULTY' | 'STAFF' | 'EXECUTIVE' | 'MANAGER' | 'POS'>;

const LEAST_PRIVILEGED_FIRST: ActorRole[] = ['STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE', 'POS', 'MANAGER'];

/**
 * True for roles that place orders on their own behalf (ordering personas).
 * These are treated like STUDENT for audit, notification, and inventory purposes.
 */
function isOrderingPersona(role: ActorRole): boolean {
  return role === 'STUDENT' || role === 'FACULTY' || role === 'STAFF' || role === 'EXECUTIVE';
}

interface Rule {
  roles: ActorRole[];
  /** Staff must explain rejections and cancellations; students may cancel without a reason. */
  reasonRequired: boolean;
}

/**
 * The approved order lifecycle (Phase 0, Q6). Anything not listed is invalid.
 *
 *   PLACED → ACCEPTED → PREPARING → READY → COMPLETED
 *     READY → COMPLETED happens only through pickup verification (pickup.service confirmHandover):
 *     the student's QR or numeric code is checked and staff explicitly confirm the handover.
 *   PLACED → REJECTED                        (manager, reason)
 *   PLACED → CANCELLED                       (the student who placed it)
 *   ACCEPTED | PREPARING → CANCELLED         (manager, reason)
 */
export const TRANSITIONS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, Rule>>>> = {
  PLACED: {
    ACCEPTED: { roles: ['MANAGER', 'POS'], reasonRequired: false },
    REJECTED: { roles: ['MANAGER'], reasonRequired: true },
    // All ordering personas (not GUEST) may cancel their own PLACED order.
    CANCELLED: { roles: ['STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'], reasonRequired: false },
  },
  ACCEPTED: {
    PREPARING: { roles: ['MANAGER', 'POS'], reasonRequired: false },
    CANCELLED: { roles: ['MANAGER'], reasonRequired: true },
  },
  PREPARING: {
    READY: { roles: ['MANAGER', 'POS'], reasonRequired: false },
    CANCELLED: { roles: ['MANAGER'], reasonRequired: true },
  },
};

/** Which next statuses the given roles may choose from the current status (for UIs). */
export function allowedNextStatuses(from: OrderStatus, roles: ActorRole[]): OrderStatus[] {
  const options = TRANSITIONS[from] ?? {};
  return (Object.entries(options) as [OrderStatus, Rule][])
    .filter(([, rule]) => rule.roles.some((r) => roles.includes(r)))
    .map(([to]) => to);
}

export interface TransitionRequest {
  orderId: string;
  to: OrderStatus;
  reason?: string;
  /** The roles the actor holds *for this order*: the owner is STUDENT; staff roles come from the outlet assignment. */
  actorRoles: ActorRole[];
  actorUserId: string;
  /** Scope: staff act on one outlet's orders, students on their own. */
  scope: { outletId: string } | { userId: string };
  /**
   * Rule-based auto-accept (PLACED → ACCEPTED only). The guard re-checks eligibility inside this
   * transaction and throws to fall back to staff; history and audit record the automatic source.
   */
  system?: {
    reason: string;
    ruleVersion: string;
    guard: (tx: DbClient, order: Order) => Promise<void>;
  };
}

export interface TransitionResult {
  order: ReturnType<typeof toOrder>;
  /** The student who owns the order (for notifications). */
  ownerId: string;
  refunded: { userId: string; amountPaise: number } | null;
  /** Group orders: every member whose share was refunded. */
  groupRefundedUserIds: string[];
  /** Loyalty points given back because the order ended (0 = none were spent). */
  pointsRestored: number;
  /** Menu items whose stock was given back because the order ended. */
  stockRestored: string[];
}

/**
 * Moves an order to a new status in one transaction: validate the transition
 * and the actor → conditional update (so two people acting at once cannot both
 * succeed) → history row → automatic wallet refund where approved → audit.
 */
export async function transitionOrder(
  db: Database,
  req: TransitionRequest,
): Promise<TransitionResult> {
  const reason = req.reason?.trim() || null;

  const result = await db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: {
        id: req.orderId,
        ...('outletId' in req.scope
          ? { outletId: req.scope.outletId }
          : { userId: req.scope.userId }),
      },
    });
    if (!order) throw notFound('Order not found');

    const studentOnly = req.actorRoles.length === 1 && req.actorRoles[0] === 'STUDENT';
    if (studentOnly && req.to === 'CANCELLED' && order.status !== 'PLACED') {
      throw new AppError(
        409,
        'TOO_LATE_TO_CANCEL',
        order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'COMPLETED'
          ? `This order is already ${order.status.toLowerCase()}.`
          : 'The outlet has already accepted this order, so it can no longer be cancelled from the app.',
      );
    }

    const rule = TRANSITIONS[order.status]?.[req.to];
    if (!rule && order.status === 'READY' && req.to === 'COMPLETED') {
      throw new AppError(
        409,
        'PICKUP_VERIFICATION_REQUIRED',
        'Verify the student’s pickup code (scan the QR or type the code) to hand this order over.',
      );
    }
    if (!rule) {
      throw new AppError(
        409,
        'INVALID_TRANSITION',
        `An order that is ${order.status} cannot become ${req.to}.`,
        {
          from: order.status,
          to: req.to,
          allowed: allowedNextStatuses(order.status, req.actorRoles),
        },
      );
    }
    // Record the least-privileged role that permits this step (a user holding both
    // MANAGER and POS who accepts an order is acting as POS).
    const actingAs = req.system
      ? null
      : LEAST_PRIVILEGED_FIRST.find((r) => rule.roles.includes(r) && req.actorRoles.includes(r));
    if (req.system) {
      if (order.status !== 'PLACED' || req.to !== 'ACCEPTED') {
        throw forbidden('Automatic acceptance only accepts placed orders.');
      }
      await req.system.guard(tx, order);
    } else if (!actingAs) {
      throw forbidden('Your role cannot make this change.');
    }
    if (rule.reasonRequired && (!reason || reason.length < 3)) {
      throw new AppError(400, 'REASON_REQUIRED', 'Please give a reason (at least 3 characters).');
    }
    // A scheduled order isn't started too early: preparation may begin once its slot is
    // within the outlet's lead time (the notice the kitchen asked for).
    if (req.to === 'PREPARING' && order.timing === 'SCHEDULED' && order.scheduledFor) {
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: order.outletId } });
      const earliest = order.scheduledFor.getTime() - outlet.scheduleLeadMinutes * 60_000;
      if (Date.now() < earliest) {
        throw new AppError(
          409,
          'TOO_EARLY_TO_PREPARE',
          `This scheduled order can be started from ${formatSlot(new Date(earliest))}.`,
          { canStartAt: new Date(earliest).toISOString() },
        );
      }
    }
    if (req.to === 'COMPLETED' && order.paymentStatus !== 'PAID') {
      throw new AppError(
        409,
        'PAYMENT_REQUIRED',
        'Record the counter payment before completing this order.',
      );
    }
    const ending = req.to === 'REJECTED' || req.to === 'CANCELLED';
    if (ending && order.paymentMethod === 'COUNTER' && order.paymentStatus === 'PAID') {
      // Cash refunds happen offline and are not modelled in this release (decision Q6).
      throw new AppError(
        409,
        'COUNTER_PAID',
        'This order was already paid at the counter and cannot be cancelled in the app.',
      );
    }

    let paymentStatus: PaymentStatus = order.paymentStatus;
    if (ending && order.paymentMethod === 'WALLET' && order.paymentStatus === 'PAID')
      paymentStatus = 'REFUNDED';
    if (ending && order.paymentMethod === 'GROUP' && order.paymentStatus === 'PAID')
      paymentStatus = 'REFUNDED';
    if (ending && order.paymentMethod === 'COUNTER' && order.paymentStatus === 'PENDING_COUNTER')
      paymentStatus = 'VOID';

    // Only succeeds if nobody else changed the order since we read it.
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: order.status, version: order.version },
      data: {
        status: req.to,
        paymentStatus,
        version: { increment: 1 },
        ...(ending && { cancelReason: reason }),
      },
    });
    if (count === 0) {
      throw new AppError(
        409,
        'ORDER_CHANGED',
        'This order was just updated by someone else. Refresh and try again.',
      );
    }

    const historyRow = await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: req.to,
        actorUserId: req.system ? null : req.actorUserId,
        actorRole: actingAs,
        reason: req.system ? req.system.reason : reason,
      },
    });
    if (req.system) {
      await recordAudit(tx, {
        actor: { type: 'SYSTEM' },
        action: 'ORDER_AUTO_ACCEPTED',
        entityType: 'Order',
        entityId: order.id,
        metadata: { ruleVersion: req.system.ruleVersion, outletId: order.outletId },
      });
    }

    let refunded: TransitionResult['refunded'] = null;
    let groupRefundedUserIds: string[] = [];
    if (paymentStatus === 'REFUNDED' && order.paymentMethod === 'GROUP') {
      // Paid in shares: each member gets their own share back.
      groupRefundedUserIds = await refundGroupOrder(
        tx,
        order.id,
        `order ${order.pickupCode} ${req.to === 'REJECTED' ? 'rejected by outlet' : 'cancelled'}`,
      );
    } else if (paymentStatus === 'REFUNDED') {
      const debit = await tx.walletTransaction.findUniqueOrThrow({
        where: { orderId_type: { orderId: order.id, type: 'ORDER_DEBIT' } },
      });
      // The full amount paid, unless the business rule keeps the scheduled-order fee.
      const refundPaise = refundablePaise(order, debit.amountPaise);
      const balanceAfter = await refundToBalance(tx, debit.walletId, refundPaise);
      // A separate compensating entry: the original debit is never modified.
      // unique(orderId, type) makes a second refund for this order impossible.
      await tx.walletTransaction.create({
        data: {
          walletId: debit.walletId,
          type: 'REFUND',
          direction: 'CREDIT',
          amountPaise: refundPaise,
          balanceAfterPaise: balanceAfter,
          status: 'COMPLETED',
          completedAt: new Date(),
          orderId: order.id,
          reversesTransactionId: debit.id,
          idempotencyKey: `order-refund:${order.id}`,
          description: `Refund for order ${order.pickupCode} (${req.to === 'REJECTED' ? 'rejected by outlet' : 'cancelled'})${
            refundPaise < debit.amountPaise ? ' — ₹10 scheduled-order fee not refunded' : ''
          }`,
          isSimulated: debit.isSimulated,
        },
      });
      refunded = { userId: order.userId, amountPaise: refundPaise };
    }

    // Points spent on an order that ends without being fulfilled are given back, once
    // (the conditional status update above can succeed only once; the ledger is unique too).
    let pointsRestored = 0;
    if (ending && order.pointsRedeemed > 0) {
      pointsRestored = await restoreForOrder(tx, {
        orderId: order.id,
        label: `order ${order.pickupCode} ${req.to === 'REJECTED' ? 'was rejected' : 'was cancelled'}`,
      });
    }

    // Stock the order took is given back exactly once (only what was actually deducted).
    let stockRestored: string[] = [];
    // (Automatic acceptance never ends an order, so a person is always acting here.)
    if (ending && actingAs) {
      // Persona roles (FACULTY, STAFF, EXECUTIVE) act as orderers, not staff.
      const inventoryRole: 'STUDENT' | 'MANAGER' | 'POS' = isOrderingPersona(actingAs)
        ? 'STUDENT'
        : (actingAs as 'MANAGER' | 'POS');
      stockRestored = await restoreStockForOrder(tx, {
        orderId: order.id,
        actor: { userId: req.actorUserId, role: inventoryRole },
        reason: `Order ${order.pickupCode} ${req.to === 'REJECTED' ? 'rejected' : 'cancelled'}`,
      });
    }

    // Real preparation time (PREPARING → READY), recorded once with the status change.
    if (req.to === 'READY') await recordReadyObservation(tx, order.id, historyRow.createdAt);

    // Pickup credentials: issued when the food is ready, revoked if the order ends instead.
    if (req.to === 'READY') {
      await issueCredential(tx, {
        orderId: order.id,
        outletId: order.outletId,
        actor: { type: 'USER', userId: req.actorUserId },
        reason: 'READY',
      });
    }
    if (ending) {
      await revokeCredentials(tx, order.id, `ORDER_${req.to}`, {
        type: 'USER',
        userId: req.actorUserId,
      });
    }

    // The student's notification commits with the change (or not at all).
    const outlet = await tx.outlet.findUniqueOrThrow({
      where: { id: order.outletId },
      select: { name: true },
    });
    await notifyOrderStatus(
      tx,
      {
        id: order.id,
        userId: order.userId,
        pickupCode: order.pickupCode,
        outletName: outlet.name,
      },
      {
        to: req.to,
        byStudent: actingAs != null && isOrderingPersona(actingAs),
        reason,
        refundPaise: refunded?.amountPaise ?? 0,
        groupRefundUserIds: groupRefundedUserIds,
      },
    );

    if (actingAs != null && !isOrderingPersona(actingAs) && ending) {
      await recordAudit(tx, {
        actor: { type: 'USER', userId: req.actorUserId },
        action: req.to === 'REJECTED' ? 'ORDER_REJECTED' : 'ORDER_CANCELLED_BY_STAFF',
        entityType: 'Order',
        entityId: order.id,
        metadata: {
          from: order.status,
          reason,
          refundedPaise: refunded?.amountPaise ?? 0,
          pointsRestored,
        },
      });
    }
    return { orderId: order.id, refunded, groupRefundedUserIds, pointsRestored, stockRestored };
  });

  const order = await db.order.findUniqueOrThrow({
    where: { id: result.orderId },
    include: orderInclude,
  });
  return {
    order: toOrder(order),
    ownerId: order.userId,
    refunded: result.refunded,
    groupRefundedUserIds: result.groupRefundedUserIds,
    pointsRestored: result.pointsRestored,
    stockRestored: result.stockRestored,
  };
}
