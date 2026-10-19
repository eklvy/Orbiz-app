import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';

// ─── Timezone helpers ─────────────────────────────────────────────────────────

/**
 * Returns the UTC offset (in ms) for a IANA timezone at a given UTC instant.
 * Positive = east of UTC (e.g. IST +5:30 = +19800000).
 *
 * Technique: format the UTC instant as a local date-time string (sv locale gives
 * ISO-like output), parse that string back as if it were UTC, and subtract.
 */
function tzOffsetMs(tz: string, utcDate: Date): number {
  const local = new Intl.DateTimeFormat('sv', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(utcDate); // e.g. "2026-10-01 05:30:00" for Asia/Kolkata
  return new Date(local.replace(' ', 'T') + 'Z').getTime() - utcDate.getTime();
}

/**
 * Returns the UTC instant that corresponds to midnight on the given year/month/day
 * in the specified IANA timezone.  Works for both fixed-offset and DST zones.
 */
function utcForLocalMidnight(year: number, month0: number, day: number, tz: string): Date {
  // Step 1: nominalise with UTC midnight as starting guess
  const nom = new Date(Date.UTC(year, month0, day, 0, 0, 0));
  // Step 2: shift back by the current TZ offset so local midnight lines up with UTC
  const approx = new Date(nom.getTime() - tzOffsetMs(tz, nom));
  // Step 3: re-check in case the offset changed across the DST boundary we just crossed
  return new Date(nom.getTime() - tzOffsetMs(tz, approx));
}

/**
 * Returns [start, end) UTC boundaries for the calendar month that contains `now`
 * when viewed in the given IANA timezone.
 */
export function monthBoundsUtc(tz: string, now: Date): { start: Date; end: Date } {
  // Determine which year/month it is right now in the target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);

  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month0 = parseInt(parts.find((p) => p.type === 'month')!.value, 10) - 1; // 0-indexed

  const nextYear = month0 === 11 ? year + 1 : year;
  const nextMonth0 = month0 === 11 ? 0 : month0 + 1;

  return {
    start: utcForLocalMidnight(year, month0, 1, tz),
    end: utcForLocalMidnight(nextYear, nextMonth0, 1, tz),
  };
}

// ─── Spending calculation ─────────────────────────────────────────────────────

/**
 * Returns net paise spent by `userId` within [monthStart, monthEnd) UTC.
 *
 * Eligible:
 *   paymentStatus = PAID          → full totalPaise
 *   paymentStatus = PARTIALLY_REFUNDED → totalPaise − noShow.refundPaise
 *
 * Not eligible:
 *   PENDING_COUNTER, VOID, REFUNDED → 0
 */
export async function getMonthlySpend(
  db: DbClient,
  userId: string,
  monthStart: Date,
  monthEnd: Date,
): Promise<number> {
  const orders = await db.order.findMany({
    where: {
      userId,
      placedAt: { gte: monthStart, lt: monthEnd },
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
    },
    select: {
      totalPaise: true,
      paymentStatus: true,
      noShow: { select: { refundPaise: true } },
    },
  });

  return orders.reduce((sum, o) => {
    const net =
      o.paymentStatus === 'PARTIALLY_REFUNDED'
        ? o.totalPaise - (o.noShow?.refundPaise ?? 0)
        : o.totalPaise;
    return sum + net;
  }, 0);
}

// ─── Serialiser ───────────────────────────────────────────────────────────────

function toBudgetView(
  budget: { limitPaise: number; timezone: string; createdAt: Date; updatedAt: Date },
  spentPaise: number,
) {
  const remainingPaise = Math.max(0, budget.limitPaise - spentPaise);
  const utilizationPct =
    budget.limitPaise > 0 ? Math.min(100, (spentPaise / budget.limitPaise) * 100) : 0;
  return {
    limitPaise: budget.limitPaise,
    timezone: budget.timezone,
    spentPaise,
    remainingPaise,
    utilizationPct: Math.round(utilizationPct * 100) / 100,
    createdAt: budget.createdAt.toISOString(),
    updatedAt: budget.updatedAt.toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface UpsertBudgetInput {
  limitPaise: number;
  timezone?: string;
}

export async function getBudget(db: Database, userId: string, now = new Date()) {
  const budget = await db.spendingBudget.findUnique({ where: { userId } });
  if (!budget) return null;
  const { start, end } = monthBoundsUtc(budget.timezone, now);
  const spentPaise = await getMonthlySpend(db, userId, start, end);
  return toBudgetView(budget, spentPaise);
}

export async function upsertBudget(
  db: Database,
  userId: string,
  actorId: string,
  input: UpsertBudgetInput,
  now = new Date(),
) {
  if (input.limitPaise < 100) {
    throw new AppError(400, 'BUDGET_TOO_LOW', 'Budget limit must be at least ₹1 (100 paise).');
  }
  if (input.timezone) {
    // Validate the timezone is a valid IANA timezone string
    try {
      Intl.DateTimeFormat(undefined, { timeZone: input.timezone });
    } catch {
      throw new AppError(400, 'INVALID_TIMEZONE', `"${input.timezone}" is not a valid IANA timezone.`);
    }
  }

  const data = {
    limitPaise: input.limitPaise,
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };

  const budget = await db.spendingBudget.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  await recordAudit(db, {
    actor: { type: 'USER', userId: actorId },
    action: 'BUDGET_UPSERTED',
    entityType: 'SpendingBudget',
    entityId: budget.id,
    metadata: { limitPaise: budget.limitPaise, timezone: budget.timezone },
  });

  const { start, end } = monthBoundsUtc(budget.timezone, now);
  const spentPaise = await getMonthlySpend(db, userId, start, end);
  return toBudgetView(budget, spentPaise);
}

export async function deleteBudget(db: Database, userId: string, actorId: string) {
  const budget = await db.spendingBudget.findUnique({ where: { userId } });
  if (!budget) throw notFound('No spending budget is set.');
  await db.spendingBudget.delete({ where: { userId } });
  await recordAudit(db, {
    actor: { type: 'USER', userId: actorId },
    action: 'BUDGET_DELETED',
    entityType: 'SpendingBudget',
    entityId: budget.id,
    metadata: { limitPaise: budget.limitPaise },
  });
}
