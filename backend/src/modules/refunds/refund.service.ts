import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { refundToBalance } from '../wallet/wallet.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RefundRequestView {
  id: string;
  orderId: string;
  orderPickupCode: string;
  amountPaise: number;
  reason: string;
  status: string;
  decidedAt: Date | null;
  decisionNote: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toView(r: {
  id: string;
  orderId: string;
  order: { pickupCode: string };
  amountPaise: number;
  reason: string;
  status: string;
  decidedAt: Date | null;
  decisionNote: string | null;
  processedAt: Date | null;
  createdAt: Date;
}): RefundRequestView {
  return {
    id: r.id,
    orderId: r.orderId,
    orderPickupCode: r.order.pickupCode,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    processedAt: r.processedAt,
    createdAt: r.createdAt,
  };
}

const refundInclude = { order: { select: { pickupCode: true } } } as const;

// ─── Submit ──────────────────────────────────────────────────────────────────

/**
 * Submits a refund request for the calling user's order.
 *
 * Rules:
 *  - Order must belong to the requesting user.
 *  - paymentStatus must be PAID or PARTIALLY_REFUNDED (money was actually received).
 *  - No active (PENDING / APPROVED) request may already exist for this order.
 *  - amountPaise must not exceed the eligible refundable balance for the order.
 */
export async function submitRefundRequest(
  db: Database,
  params: {
    orderId: string;
    requestedByUserId: string;
    amountPaise: number;
    reason: string;
  },
): Promise<RefundRequestView> {
  const { orderId, requestedByUserId, amountPaise, reason } = params;

  const result = await db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, userId: requestedByUserId },
      include: { counterPayment: true, noShow: true },
    });
    if (!order) throw notFound('Order not found');

    if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED') {
      throw new AppError(
        409,
        'REFUND_NOT_ELIGIBLE',
        'A refund request can only be submitted for a paid order.',
        { paymentStatus: order.paymentStatus },
      );
    }

    // Prevent duplicate active requests.
    const existing = await tx.refundRequest.findFirst({
      where: { orderId, status: { in: ['PENDING', 'APPROVED'] } },
    });
    if (existing) {
      throw new AppError(
        409,
        'DUPLICATE_REFUND_REQUEST',
        'A refund request for this order is already pending.',
        { existingRequestId: existing.id },
      );
    }

    // Determine the maximum refundable amount.
    const alreadyProcessed = await tx.refundRequest.aggregate({
      where: { orderId, status: 'PROCESSED' },
      _sum: { amountPaise: true },
    });
    const processedPaise = alreadyProcessed._sum.amountPaise ?? 0;

    let maxRefundable: number;
    if (order.paymentMethod === 'COUNTER') {
      maxRefundable = (order.counterPayment?.amountPaise ?? 0) - processedPaise;
    } else {
      // WALLET or GROUP: the no-show policy may already have returned part of the total.
      const noShowRefund = order.noShow?.refundPaise ?? 0;
      maxRefundable = order.totalPaise - noShowRefund - processedPaise;
    }

    if (amountPaise > maxRefundable) {
      throw new AppError(
        409,
        'AMOUNT_EXCEEDS_ELIGIBLE',
        `The maximum refundable amount for this order is ${maxRefundable} paise.`,
        { maxRefundable, amountPaise },
      );
    }

    const req = await tx.refundRequest.create({
      data: { orderId, requestedByUserId, amountPaise, reason },
      include: refundInclude,
    });
    return req;
  });

  return toView(result);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/** Returns the refund request for a specific order, visible to the order owner. */
export async function getOwnRefundRequest(
  db: Database,
  orderId: string,
  userId: string,
): Promise<RefundRequestView | null> {
  const req = await db.refundRequest.findFirst({
    where: { orderId, requestedByUserId: userId },
    include: refundInclude,
    orderBy: { createdAt: 'desc' },
  });
  return req ? toView(req) : null;
}

// ─── List (admin / manager) ───────────────────────────────────────────────────

/** Lists refund requests, newest first, optionally filtered by status. */
export async function listRefundRequests(
  db: Database,
  options: {
    status?: string;
    outletId?: string;
    limit: number;
    cursor?: string;
  },
): Promise<{ requests: RefundRequestView[]; nextCursor: string | null }> {
  const after = options.cursor
    ? Buffer.from(options.cursor, 'base64url').toString()
    : null;
  const afterDate = after ? new Date(after.split('|')[0] ?? '') : null;
  const afterId = after ? (after.split('|')[1] ?? null) : null;

  const rows = await db.refundRequest.findMany({
    where: {
      ...(options.status && { status: options.status as never }),
      ...(options.outletId && { order: { outletId: options.outletId } }),
      ...(afterDate &&
        afterId && {
          OR: [
            { createdAt: { lt: afterDate } },
            { createdAt: afterDate, id: { lt: afterId } },
          ],
        }),
    },
    include: refundInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });

  const page = rows.slice(0, options.limit);
  const lastRow = page[page.length - 1];
  const nextCursor =
    rows.length > options.limit && lastRow
      ? Buffer.from(`${lastRow.createdAt.toISOString()}|${lastRow.id}`).toString('base64url')
      : null;

  return { requests: page.map(toView), nextCursor };
}

// ─── Decide (manager / admin) ─────────────────────────────────────────────────

/**
 * Approves or rejects a PENDING refund request.
 * APPROVED means the manager agrees money should be returned — NOT that it has been.
 */
export async function decideRefundRequest(
  db: Database,
  params: {
    requestId: string;
    decision: 'APPROVED' | 'REJECTED';
    decidedByUserId: string;
    note?: string;
  },
): Promise<RefundRequestView> {
  const { requestId, decision, decidedByUserId, note } = params;

  const result = await db.$transaction(async (tx) => {
    const req = await tx.refundRequest.findUnique({
      where: { id: requestId },
      include: refundInclude,
    });
    if (!req) throw notFound('Refund request not found');

    if (req.status !== 'PENDING') {
      throw new AppError(
        409,
        'INVALID_REFUND_TRANSITION',
        `Cannot ${decision.toLowerCase()} a request that is already ${req.status.toLowerCase()}.`,
        { currentStatus: req.status },
      );
    }

    const updated = await tx.refundRequest.update({
      where: { id: requestId },
      data: {
        status: decision,
        decidedByUserId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
      include: refundInclude,
    });

    await recordAudit(tx, {
      actor: { type: 'USER', userId: decidedByUserId },
      action: decision === 'APPROVED' ? 'REFUND_REQUEST_APPROVED' : 'REFUND_REQUEST_REJECTED',
      entityType: 'RefundRequest',
      entityId: requestId,
      metadata: { orderId: req.orderId, amountPaise: req.amountPaise, note: note ?? null },
    });

    return updated;
  });

  return toView(result);
}

// ─── Process (admin) ──────────────────────────────────────────────────────────

/**
 * Marks an APPROVED refund request as PROCESSED.
 *
 * For WALLET orders: credits the wallet atomically inside the same transaction.
 * For COUNTER orders: marks it processed — the cash return happens offline.
 * For GROUP orders: marks it processed — group refunds follow a separate flow.
 *
 * This is intentionally a separate step from APPROVED so that the decision
 * (does the student deserve a refund?) is decoupled from the execution
 * (has the money actually been returned?).
 */
export async function processRefundRequest(
  db: Database,
  params: { requestId: string; processedByUserId: string },
): Promise<RefundRequestView> {
  const { requestId, processedByUserId } = params;

  const result = await db.$transaction(async (tx) => {
    const req = await tx.refundRequest.findUnique({
      where: { id: requestId },
      include: {
        order: {
          select: {
            pickupCode: true,
            paymentMethod: true,
            userId: true,
          },
        },
      },
    });
    if (!req) throw notFound('Refund request not found');

    if (req.status !== 'APPROVED') {
      throw new AppError(
        409,
        'INVALID_REFUND_TRANSITION',
        `Cannot process a refund request that is ${req.status.toLowerCase()}.`,
        { currentStatus: req.status },
      );
    }

    const now = new Date();

    // For wallet-funded orders we execute the wallet credit here.
    if (req.order.paymentMethod === 'WALLET') {
      // Find the original debit to copy its isSimulated flag (preserves the
      // test/prod boundary — simulated money should stay simulated).
      const originalDebit = await tx.walletTransaction.findFirst({
        where: { orderId: req.orderId, type: 'ORDER_DEBIT' },
        select: { walletId: true, isSimulated: true },
      });
      if (!originalDebit) {
        throw new AppError(
          409,
          'WALLET_TRANSACTION_MISSING',
          'Could not find the original wallet debit for this order.',
        );
      }

      const balanceAfter = await refundToBalance(
        tx,
        originalDebit.walletId,
        req.amountPaise,
      );

      // idempotencyKey makes a second processing attempt for the same request a no-op.
      await tx.walletTransaction.create({
        data: {
          walletId: originalDebit.walletId,
          type: 'REFUND',
          direction: 'CREDIT',
          amountPaise: req.amountPaise,
          balanceAfterPaise: balanceAfter,
          status: 'COMPLETED',
          completedAt: now,
          // orderId intentionally omitted: the @@unique([orderId, type]) constraint would
          // block processing when the order already has an automatic-refund REFUND row.
          idempotencyKey: `refund-request:${req.id}`,
          description: `Refund request approved for order ${req.order.pickupCode}`,
          isSimulated: originalDebit.isSimulated,
        },
      });
    }

    const updated = await tx.refundRequest.update({
      where: { id: requestId },
      data: { status: 'PROCESSED', processedAt: now },
      include: refundInclude,
    });

    await recordAudit(tx, {
      actor: { type: 'USER', userId: processedByUserId },
      action: 'REFUND_REQUEST_PROCESSED',
      entityType: 'RefundRequest',
      entityId: requestId,
      metadata: {
        orderId: req.orderId,
        amountPaise: req.amountPaise,
        paymentMethod: req.order.paymentMethod,
      },
    });

    return updated;
  });

  return toView(result);
}
