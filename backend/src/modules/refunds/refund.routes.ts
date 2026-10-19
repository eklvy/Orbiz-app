import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  decideRefundRequest,
  getOwnRefundRequest,
  listRefundRequests,
  processRefundRequest,
  submitRefundRequest,
} from './refund.service.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const submitBody = z
  .object({
    amountPaise: z.number().int().min(1),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

const decideBody = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const listQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'PROCESSED']).optional(),
  outletId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

function parseId(value: unknown, label: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw notFound(`${label} not found`);
  return parsed.data;
}

// ─── Student: submit + view own request ───────────────────────────────────────

/**
 * Mounts under /orders/:orderId/refund-request.
 * The :orderId comes from the parent router via mergeParams.
 */
export function orderRefundRouter(db: Database): Router {
  const router = Router({ mergeParams: true });
  router.use(requireRole('STUDENT', 'FACULTY', 'STAFF', 'EXECUTIVE'));

  /** POST / — submit a refund request for the student's own order. */
  router.post('/', async (req, res) => {
    const orderId = parseId((req.params as Record<string, string>).orderId, 'Order');
    const { amountPaise, reason } = submitBody.parse(req.body);
    const refundRequest = await submitRefundRequest(db, {
      orderId,
      requestedByUserId: req.auth!.user.id,
      amountPaise,
      reason,
    });
    res.status(201).json({ refundRequest });
  });

  /** GET / — view the current refund request for this order. */
  router.get('/', async (req, res) => {
    const orderId = parseId((req.params as Record<string, string>).orderId, 'Order');
    const refundRequest = await getOwnRefundRequest(db, orderId, req.auth!.user.id);
    res.json({ refundRequest }); // null if none submitted
  });

  return router;
}

// ─── Admin / manager: list, decide, process ───────────────────────────────────

/**
 * Admin and manager routes for the refund desk.
 * Deciding (approve/reject) is allowed for ADMIN and MANAGER.
 * Processing (executing the wallet credit) is admin-only.
 */
export function adminRefundRouter(db: Database): Router {
  const router = Router();
  // Both ADMIN and MANAGER may access these routes (decide); individual
  // handlers narrow further for process.
  router.use(requireRole('ADMIN', 'MANAGER'));

  /** GET / — list all refund requests, optionally filtered by status or outlet. */
  router.get('/', async (req, res) => {
    const { status, outletId, limit, cursor } = listQuery.parse(req.query);
    const result = await listRefundRequests(db, { status, outletId, limit, cursor });
    res.json(result);
  });

  /** POST /:requestId/decide — approve or reject. */
  router.post('/:requestId/decide', async (req, res) => {
    const requestId = parseId(req.params.requestId, 'Refund request');
    const { decision, note } = decideBody.parse(req.body);
    const refundRequest = await decideRefundRequest(db, {
      requestId,
      decision,
      decidedByUserId: req.auth!.user.id,
      note,
    });
    res.json({ refundRequest });
  });

  /** POST /:requestId/process — execute the refund (admin only). */
  router.post('/:requestId/process', requireRole('ADMIN'), async (req, res) => {
    const requestId = parseId(req.params.requestId, 'Refund request');
    const refundRequest = await processRefundRequest(db, {
      requestId,
      processedByUserId: req.auth!.user.id,
    });
    res.json({ refundRequest });
  });

  return router;
}

/**
 * Staff (outlet-scoped) view of refund requests for orders at their outlet.
 * Mounts under /staff/outlets/:outletId/refund-requests.
 * Managers and POS staff see PENDING requests for their outlet.
 */
export function staffRefundRouter(db: Database): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const outletId = parseId((req.params as Record<string, string>).outletId, 'Outlet');
    const { status, limit, cursor } = listQuery.parse(req.query);
    const result = await listRefundRequests(db, {
      status,
      outletId,
      limit,
      cursor,
    });
    res.json(result);
  });

  return router;
}
