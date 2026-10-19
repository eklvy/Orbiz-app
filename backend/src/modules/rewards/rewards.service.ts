import { randomBytes } from 'node:crypto';
import type { Database, DbClient } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { ensureWallet } from '../wallet/wallet.service.js';
import { takePoints } from '../loyalty/loyalty.service.js';

/*
 * Rewards catalog service.
 *
 * Redemption is atomic:
 *   1. pg_advisory_xact_lock per reward — serialises concurrent claims of the
 *      same reward so the stock check and decrement cannot race.
 *   2. takePoints() — atomic UPDATE on the Wallet row (row-level lock) so the
 *      same points can never be spent twice by concurrent requests.
 *   3. Both happen inside a single db.$transaction, so any failure rolls
 *      everything back — no orphan point deductions or ghost redemptions.
 */

// ─── Voucher code generation ──────────────────────────────────────────────────

/**
 * Generates a short, URL-safe voucher code.
 * Format: <PREFIX>-<8 uppercase base-36 chars> — e.g. "ORBIZ-X3K7M2P9".
 * Cryptographically random; collision probability is negligible for any
 * realistic redemption volume.
 */
function generateVoucherCode(prefix: string): string {
  const suffix = randomBytes(5)
    .reduce((acc, b) => acc * 256 + b, 0)
    .toString(36)
    .toUpperCase()
    .padStart(8, '0')
    .slice(-8);
  return `${prefix.toUpperCase()}-${suffix}`;
}

// ─── Advisory lock ────────────────────────────────────────────────────────────

const lockReward = (tx: DbClient, rewardId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reward:${rewardId}`}))`;

// ─── Serialiser ───────────────────────────────────────────────────────────────

function toReward(r: {
  id: string;
  name: string;
  description: string;
  pointCost: number;
  isActive: boolean;
  voucherPrefix: string | null;
  totalStock: number | null;
  redeemedCount: number;
  validFrom: Date | null;
  validUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const stock =
    r.totalStock === null
      ? null
      : { total: r.totalStock, remaining: r.totalStock - r.redeemedCount };
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    pointCost: r.pointCost,
    isActive: r.isActive,
    hasVoucher: r.voucherPrefix !== null,
    stock,
    validFrom: r.validFrom?.toISOString() ?? null,
    validUntil: r.validUntil?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toRedemption(r: {
  id: string;
  rewardId: string;
  voucherCode: string | null;
  redeemedAt: Date | null;
  createdAt: Date;
  reward: { name: string; pointCost: number };
}) {
  return {
    id: r.id,
    rewardId: r.rewardId,
    rewardName: r.reward.name,
    pointCost: r.reward.pointCost,
    voucherCode: r.voucherCode,
    redeemedAt: r.redeemedAt?.toISOString() ?? null,
    claimedAt: r.createdAt.toISOString(),
  };
}

// ─── Eligibility check (runs inside the advisory lock) ────────────────────────

async function checkEligibility(tx: DbClient, rewardId: string, now: Date) {
  const reward = await tx.rewardCatalog.findUnique({ where: { id: rewardId } });
  if (!reward || !reward.isActive) throw notFound('Reward not found or no longer active.');

  if (reward.validFrom && now < reward.validFrom) {
    throw new AppError(409, 'REWARD_NOT_YET_AVAILABLE', 'This reward is not available yet.');
  }
  if (reward.validUntil && now > reward.validUntil) {
    throw new AppError(409, 'REWARD_EXPIRED', 'This reward has expired.');
  }
  if (reward.totalStock !== null && reward.redeemedCount >= reward.totalStock) {
    throw new AppError(409, 'REWARD_OUT_OF_STOCK', 'This reward is out of stock.', {
      totalStock: reward.totalStock,
    });
  }
  return reward;
}

// ─── Public: list active rewards ──────────────────────────────────────────────

export async function listActiveRewards(db: Database, now = new Date()) {
  const rewards = await db.rewardCatalog.findMany({
    where: {
      isActive: true,
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    orderBy: { pointCost: 'asc' },
  });
  // Filter out fully claimed rewards
  return rewards
    .filter((r) => r.totalStock === null || r.redeemedCount < r.totalStock)
    .map(toReward);
}

// ─── Student: redeem a reward ─────────────────────────────────────────────────

export async function redeemReward(
  db: Database,
  userId: string,
  rewardId: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    // 1. Advisory lock: one redemption of this reward at a time
    await lockReward(tx, rewardId);

    // 2. Eligibility checks (re-reads inside the lock)
    const reward = await checkEligibility(tx, rewardId, now);

    // 3. Ensure wallet exists, then atomically deduct points
    const wallet = await ensureWallet(tx, userId);
    const balanceAfter = await takePoints(tx, wallet.id, reward.pointCost);
    if (balanceAfter === null) {
      const w = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      throw new AppError(409, 'INSUFFICIENT_POINTS', "You don't have enough loyalty points.", {
        pointsBalance: w.pointsBalance,
        required: reward.pointCost,
      });
    }

    // 4. Record the points deduction in the loyalty ledger
    const loyaltyTx = await tx.loyaltyTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'REDEEMED_REWARD',
        direction: 'DEBIT',
        points: reward.pointCost,
        pointsBalanceAfter: balanceAfter,
        idempotencyKey: `reward-redeem:${userId}:${rewardId}:${now.getTime()}`,
        description: `Claimed reward: ${reward.name}`,
        isSimulated: false,
      },
    });

    // 5. Generate voucher code if the reward issues one
    const voucherCode = reward.voucherPrefix
      ? generateVoucherCode(reward.voucherPrefix)
      : null;

    // 6. Create the redemption record
    const redemption = await tx.rewardRedemption.create({
      data: {
        userId,
        rewardId,
        loyaltyTxId: loyaltyTx.id,
        voucherCode,
      },
      include: { reward: { select: { name: true, pointCost: true } } },
    });

    // 7. Increment the stock counter atomically
    await tx.rewardCatalog.update({
      where: { id: rewardId },
      data: { redeemedCount: { increment: 1 } },
    });

    await recordAudit(tx, {
      actor: { type: 'USER', userId },
      action: 'REWARD_REDEEMED',
      entityType: 'RewardCatalog',
      entityId: rewardId,
      metadata: { redemptionId: redemption.id, pointsSpent: reward.pointCost },
    });

    return { redemption: toRedemption(redemption), pointsBalanceAfter: balanceAfter };
  });
}

// ─── Student: own redemption history ─────────────────────────────────────────

export async function listMyRedemptions(db: Database, userId: string) {
  const rows = await db.rewardRedemption.findMany({
    where: { userId },
    include: { reward: { select: { name: true, pointCost: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(toRedemption);
}

// ─── Admin: full catalog management ──────────────────────────────────────────

export async function listAllRewards(db: Database) {
  const rewards = await db.rewardCatalog.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rewards.map(toReward);
}

export interface CreateRewardInput {
  name: string;
  description?: string;
  pointCost: number;
  voucherPrefix?: string;
  totalStock?: number;
  validFrom?: Date;
  validUntil?: Date;
}

export async function createReward(db: Database, actorId: string, input: CreateRewardInput) {
  const reward = await db.$transaction(async (tx) => {
    const created = await tx.rewardCatalog.create({
      data: {
        name: input.name,
        description: input.description ?? '',
        pointCost: input.pointCost,
        voucherPrefix: input.voucherPrefix ?? null,
        totalStock: input.totalStock ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: actorId },
      action: 'REWARD_CREATED',
      entityType: 'RewardCatalog',
      entityId: created.id,
      metadata: { name: created.name, pointCost: created.pointCost },
    });
    return created;
  });
  return toReward(reward);
}

export interface UpdateRewardInput {
  name?: string;
  description?: string;
  pointCost?: number;
  isActive?: boolean;
  voucherPrefix?: string | null;
  totalStock?: number | null;
  validFrom?: Date | null;
  validUntil?: Date | null;
}

export async function updateReward(
  db: Database,
  rewardId: string,
  actorId: string,
  input: UpdateRewardInput,
) {
  const existing = await db.rewardCatalog.findUnique({ where: { id: rewardId } });
  if (!existing) throw notFound('Reward not found.');

  if (input.totalStock !== undefined && input.totalStock !== null) {
    if (input.totalStock < existing.redeemedCount) {
      throw new AppError(
        409,
        'STOCK_BELOW_REDEEMED',
        `Cannot set stock to ${input.totalStock} — ${existing.redeemedCount} have already been redeemed.`,
        { redeemedCount: existing.redeemedCount },
      );
    }
  }

  const reward = await db.$transaction(async (tx) => {
    const updated = await tx.rewardCatalog.update({
      where: { id: rewardId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.pointCost !== undefined ? { pointCost: input.pointCost } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...('voucherPrefix' in input ? { voucherPrefix: input.voucherPrefix } : {}),
        ...('totalStock' in input ? { totalStock: input.totalStock } : {}),
        ...('validFrom' in input ? { validFrom: input.validFrom } : {}),
        ...('validUntil' in input ? { validUntil: input.validUntil } : {}),
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: actorId },
      action: 'REWARD_UPDATED',
      entityType: 'RewardCatalog',
      entityId: rewardId,
      metadata: input as Prisma.InputJsonValue,
    });
    return updated;
  });
  return toReward(reward);
}

export async function listRewardRedemptions(
  db: Database,
  rewardId: string,
) {
  const reward = await db.rewardCatalog.findUnique({ where: { id: rewardId } });
  if (!reward) throw notFound('Reward not found.');
  const rows = await db.rewardRedemption.findMany({
    where: { rewardId },
    include: {
      reward: { select: { name: true, pointCost: true } },
      user: { select: { id: true, email: true, displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((r) => ({
    ...toRedemption(r),
    user: r.user,
  }));
}
