import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import {
  createReward,
  listActiveRewards,
  listAllRewards,
  listMyRedemptions,
  listRewardRedemptions,
  redeemReward,
  updateReward,
} from './rewards.service.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createRewardBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    pointCost: z.number().int().min(1),
    voucherPrefix: z.string().trim().min(1).max(20).optional(),
    totalStock: z.number().int().min(1).optional(),
    validFrom: z
      .iso.datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
    validUntil: z
      .iso.datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  })
  .strict();

const updateRewardBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    pointCost: z.number().int().min(1).optional(),
    isActive: z.boolean().optional(),
    voucherPrefix: z.string().trim().min(1).max(20).nullable().optional(),
    totalStock: z.number().int().min(1).nullable().optional(),
    validFrom: z
      .iso.datetime({ offset: true })
      .transform((v) => new Date(v))
      .nullable()
      .optional(),
    validUntil: z
      .iso.datetime({ offset: true })
      .transform((v) => new Date(v))
      .nullable()
      .optional(),
  })
  .strict();

function parseRewardId(id: unknown) {
  const parsed = uuidParam.safeParse(id);
  if (!parsed.success) throw notFound('Reward not found.');
  return parsed.data;
}

// ─── Public: browse active rewards ────────────────────────────────────────────

/** GET /rewards — any signed-in user can browse the active reward catalog. */
export function rewardsRouter(db: Database) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (_req, res) => {
    res.json({ rewards: await listActiveRewards(db) });
  });

  return router;
}

// ─── Student: redeem rewards + history ───────────────────────────────────────

/** /me/rewards — student's own redemption history and redemption action. */
export function myRewardsRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  /** GET / — my redemption history. */
  router.get('/', async (req, res) => {
    res.json({ redemptions: await listMyRedemptions(db, req.auth!.user.id) });
  });

  return router;
}

/** POST /rewards/:rewardId/redeem — STUDENT redeems a reward. */
export function redeemRewardRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  router.post('/:rewardId/redeem', async (req, res) => {
    const rewardId = parseRewardId(req.params.rewardId);
    const result = await redeemReward(db, req.auth!.user.id, rewardId);
    res.status(201).json(result);
  });

  return router;
}

// ─── Admin: full catalog management ──────────────────────────────────────────

/** /admin/rewards — administrator CRUD for the reward catalog. */
export function adminRewardsRouter(db: Database) {
  const router = Router();
  router.use(requireRole('ADMIN'));

  /** GET / — list all rewards including inactive. */
  router.get('/', async (_req, res) => {
    res.json({ rewards: await listAllRewards(db) });
  });

  /** POST / — create a new reward. */
  router.post('/', async (req, res) => {
    const body = createRewardBody.parse(req.body);
    const reward = await createReward(db, req.auth!.user.id, body);
    res.status(201).json({ reward });
  });

  /** PATCH /:rewardId — update an existing reward. */
  router.patch('/:rewardId', async (req, res) => {
    const rewardId = parseRewardId(req.params.rewardId);
    const body = updateRewardBody.parse(req.body);
    const reward = await updateReward(db, rewardId, req.auth!.user.id, body);
    res.json({ reward });
  });

  /** GET /:rewardId/redemptions — list all redemptions for a reward. */
  router.get('/:rewardId/redemptions', async (req, res) => {
    const rewardId = parseRewardId(req.params.rewardId);
    res.json({ redemptions: await listRewardRedemptions(db, rewardId) });
  });

  return router;
}
