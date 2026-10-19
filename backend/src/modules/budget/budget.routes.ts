import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import { getBudget, upsertBudget, deleteBudget } from './budget.service.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const upsertBody = z
  .object({
    /** Monthly cap in paise (₹1 = 100). Minimum ₹1. */
    limitPaise: z.number().int().min(100),
    /** IANA timezone string. Defaults to 'Asia/Kolkata'. */
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

// ─── Student / self: own budget ───────────────────────────────────────────────

/** /me/budget — the signed-in user's own spending budget. */
export function myBudgetRouter(db: Database) {
  const router = Router();
  router.use(requireAuth);

  /** GET / — current budget, monthly spend, remaining, utilization. */
  router.get('/', async (req, res) => {
    const budget = await getBudget(db, req.auth!.user.id);
    res.json({ budget }); // null when no cap is set
  });

  /** PUT / — set or replace the monthly budget cap. */
  router.put('/', async (req, res) => {
    const input = upsertBody.parse(req.body);
    const budget = await upsertBudget(db, req.auth!.user.id, req.auth!.user.id, input);
    res.json({ budget });
  });

  /** DELETE / — remove the monthly cap. */
  router.delete('/', async (req, res) => {
    await deleteBudget(db, req.auth!.user.id, req.auth!.user.id);
    res.status(204).send();
  });

  return router;
}

// ─── Admin: view any user's budget ────────────────────────────────────────────

/**
 * /admin/users/:userId/budget — administrator budget inspection and management.
 * Admin can also set/delete a user's budget on their behalf (e.g. enforced institutional cap).
 */
export function adminUserBudgetRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireRole('ADMIN'));

  function parseUserId(req: import('express').Request) {
    const id = (req.params as Record<string, string>).userId;
    const parsed = uuidParam.safeParse(id);
    if (!parsed.success) throw notFound('User not found.');
    return parsed.data;
  }

  /** GET / — read the user's current budget and monthly spend. */
  router.get('/', async (req, res) => {
    const userId = parseUserId(req);
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw notFound('User not found.');
    const budget = await getBudget(db, userId);
    res.json({ budget });
  });

  /** PUT / — set or replace a user's monthly budget (admin on behalf of user). */
  router.put('/', async (req, res) => {
    const userId = parseUserId(req);
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw notFound('User not found.');
    const input = upsertBody.parse(req.body);
    const budget = await upsertBudget(db, userId, req.auth!.user.id, input);
    res.json({ budget });
  });

  /** DELETE / — remove a user's monthly budget. */
  router.delete('/', async (req, res) => {
    const userId = parseUserId(req);
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw notFound('User not found.');
    await deleteBudget(db, userId, req.auth!.user.id);
    res.status(204).send();
  });

  return router;
}
