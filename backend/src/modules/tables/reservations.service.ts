import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { ReservationStatus, Role } from '../../generated/prisma/enums.js';
import { istDayOf, istMidnight, weekdayOf } from '../scheduling/slots.js';

/*
 * Table reservations lifecycle:
 *
 *   PENDING → CONFIRMED  (manager)
 *   PENDING → REJECTED   (manager, reason required)
 *   PENDING / CONFIRMED → CANCELLED  (user, only before startsAt)
 *   CONFIRMED → COMPLETED (manager, only after startsAt)
 *   PENDING / CONFIRMED → EXPIRED   (system job, when startsAt passes)
 */

const MIN_ADVANCE_MS = 15 * 60_000; // 15 minutes minimum notice
const MAX_AHEAD_MS = 30 * 24 * 3_600_000; // 30 days max
const MAX_DURATION_MS = 4 * 3_600_000; // 4 hours max duration

type Tx = DbClient;

// ─── Advisory lock — one outlet's reservations at a time ─────────────────────

const lockOutletReservations = (tx: Tx, outletId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reservation:${outletId}`}))`;

// ─── Serializer ───────────────────────────────────────────────────────────────

type ReservationRow = Awaited<ReturnType<typeof loadReservation>>;

function toReservation(r: NonNullable<ReservationRow>) {
  return {
    id: r.id,
    status: r.status,
    outlet: r.outlet,
    table: r.table
      ? { id: r.table.id, label: r.table.label, capacity: r.table.capacity }
      : null,
    partySize: r.partySize,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    notes: r.notes,
    decisionReason: r.decisionReason,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    expiredAt: r.expiredAt?.toISOString() ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    history: r.history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actorRole: h.actorRole,
      reason: h.reason,
      at: h.createdAt.toISOString(),
    })),
  };
}

const reservationInclude = {
  outlet: { select: { id: true, name: true, slug: true, location: true } },
  table: { select: { id: true, label: true, capacity: true } },
  history: {
    orderBy: { createdAt: 'asc' as const },
  },
};

const loadReservation = (db: Tx, where: { id: string }) =>
  db.tableReservation.findUnique({ where, include: reservationInclude });

// ─── Validation helpers ───────────────────────────────────────────────────────

async function validateReservationRequest(
  tx: Tx,
  params: {
    outletId: string;
    tableId?: string;
    partySize: number;
    startsAt: Date;
    endsAt: Date;
    excludeId?: string;
  },
  now: Date,
) {
  const outlet = await tx.outlet.findUnique({
    where: { id: params.outletId },
    include: { hours: true },
  });
  if (!outlet || !outlet.isActive) {
    throw new AppError(409, 'OUTLET_UNAVAILABLE', 'This outlet is not available for reservations.');
  }

  // Time range sanity
  const startMs = params.startsAt.getTime();
  const endMs = params.endsAt.getTime();
  const nowMs = now.getTime();

  if (startMs < nowMs + MIN_ADVANCE_MS) {
    throw new AppError(
      409,
      'TOO_SOON',
      'Reservations must be made at least 15 minutes in advance.',
      { minAdvanceMinutes: 15 },
    );
  }
  if (startMs > nowMs + MAX_AHEAD_MS) {
    throw new AppError(409, 'TOO_FAR', 'Reservations cannot be made more than 30 days ahead.');
  }
  if (endMs - startMs > MAX_DURATION_MS) {
    throw new AppError(409, 'DURATION_TOO_LONG', 'Reservation duration cannot exceed 4 hours.');
  }

  // Must fall within the outlet's operating hours on that IST day
  const day = istDayOf(startMs);
  const midnight = istMidnight(day);
  const startMinute = Math.round((startMs - midnight) / 60_000);
  const endMinute = Math.round((endMs - midnight) / 60_000);
  const hours = outlet.hours.find((h) => h.weekday === weekdayOf(day));

  if (!hours) {
    throw new AppError(
      409,
      'OUTSIDE_HOURS',
      'This outlet has no operating hours on the chosen day.',
      { weekday: weekdayOf(day) },
    );
  }
  if (startMinute < hours.opensMinute || endMinute > hours.closesMinute) {
    throw new AppError(
      409,
      'OUTSIDE_HOURS',
      "The reservation must start and finish within the outlet's operating hours.",
      { opensMinute: hours.opensMinute, closesMinute: hours.closesMinute },
    );
  }

  // Specific table validation
  if (params.tableId) {
    const table = await tx.diningTable.findFirst({
      where: { id: params.tableId, outletId: params.outletId },
    });
    if (!table) throw notFound('Table not found at this outlet.');
    if (!table.isActive) {
      throw new AppError(409, 'TABLE_UNAVAILABLE', 'This table is not available for reservations.');
    }
    if (params.partySize > table.capacity) {
      throw new AppError(
        409,
        'PARTY_TOO_LARGE',
        `Party size (${params.partySize}) exceeds this table's capacity (${table.capacity}).`,
        { tableCapacity: table.capacity },
      );
    }

    // Overlap check for the specific table
    const overlapping = await tx.tableReservation.count({
      where: {
        tableId: params.tableId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { lt: params.endsAt },
        endsAt: { gt: params.startsAt },
        ...(params.excludeId ? { NOT: { id: params.excludeId } } : {}),
      },
    });
    if (overlapping > 0) {
      throw new AppError(
        409,
        'TABLE_UNAVAILABLE',
        'This table is already reserved for that time slot.',
      );
    }
  }
}

// ─── Public mutations ─────────────────────────────────────────────────────────

export interface CreateReservationInput {
  outletId: string;
  tableId?: string;
  partySize: number;
  startsAt: Date;
  endsAt: Date;
  notes?: string;
}

export async function createReservation(
  db: Database,
  userId: string,
  input: CreateReservationInput,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    await lockOutletReservations(tx, input.outletId);
    await validateReservationRequest(tx, input, now);

    const reservation = await tx.tableReservation.create({
      data: {
        userId,
        outletId: input.outletId,
        tableId: input.tableId ?? null,
        partySize: input.partySize,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        notes: input.notes ?? '',
        history: {
          create: {
            toStatus: 'PENDING',
            actorUserId: userId,
            actorRole: 'STUDENT',
          },
        },
      },
      include: reservationInclude,
    });
    return toReservation(reservation);
  });
}

// ─── User queries ─────────────────────────────────────────────────────────────

export async function listMyReservations(db: Database, userId: string) {
  const rows = await db.tableReservation.findMany({
    where: { userId },
    include: reservationInclude,
    orderBy: { startsAt: 'desc' },
    take: 50,
  });
  return rows.map(toReservation);
}

export async function getMyReservation(db: Database, userId: string, reservationId: string) {
  const r = await loadReservation(db, { id: reservationId });
  if (!r || r.userId !== userId) throw notFound('Reservation not found.');
  return toReservation(r);
}

// ─── User mutations ───────────────────────────────────────────────────────────

export async function cancelReservation(
  db: Database,
  userId: string,
  reservationId: string,
  reason?: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    const r = await tx.tableReservation.findFirst({
      where: { id: reservationId, userId },
    });
    if (!r) throw notFound('Reservation not found.');

    if (!['PENDING', 'CONFIRMED'].includes(r.status)) {
      throw new AppError(
        409,
        'INVALID_RESERVATION_TRANSITION',
        `A ${r.status.toLowerCase()} reservation cannot be cancelled.`,
        { status: r.status },
      );
    }
    if (r.startsAt.getTime() <= now.getTime()) {
      throw new AppError(409, 'RESERVATION_STARTED', 'The reservation time has already passed.');
    }

    const { count } = await tx.tableReservation.updateMany({
      where: { id: r.id, version: r.version, status: r.status },
      data: { status: 'CANCELLED', cancelledAt: now, version: { increment: 1 } },
    });
    if (count === 0)
      throw new AppError(409, 'RESERVATION_CHANGED', 'This reservation just changed. Reload and try again.');

    await tx.reservationStatusHistory.create({
      data: {
        reservationId: r.id,
        fromStatus: r.status,
        toStatus: 'CANCELLED',
        actorUserId: userId,
        actorRole: 'STUDENT',
        reason: reason ?? null,
      },
    });

    return toReservation((await loadReservation(tx, { id: r.id }))!);
  });
}

// ─── Staff queries ────────────────────────────────────────────────────────────

export async function listOutletReservations(
  db: Database,
  outletId: string,
  status?: ReservationStatus,
) {
  const rows = await db.tableReservation.findMany({
    where: { outletId, ...(status ? { status } : {}) },
    include: reservationInclude,
    orderBy: { startsAt: 'asc' },
    take: 200,
  });
  return rows.map(toReservation);
}

export async function getOutletReservation(
  db: Database,
  outletId: string,
  reservationId: string,
) {
  const r = await loadReservation(db, { id: reservationId });
  if (!r || r.outletId !== outletId) throw notFound('Reservation not found.');
  return toReservation(r);
}

// ─── Staff state transitions ──────────────────────────────────────────────────

async function transition(
  db: Database,
  params: {
    outletId: string;
    reservationId: string;
    from: ReservationStatus[];
    to: ReservationStatus;
    actor: { userId: string; role: Role };
    reason?: string;
    check?: (tx: Tx, r: { id: string; startsAt: Date; endsAt: Date; tableId: string | null }) => Promise<void>;
  },
) {
  return db.$transaction(async (tx) => {
    await lockOutletReservations(tx, params.outletId);

    const r = await tx.tableReservation.findFirst({
      where: { id: params.reservationId, outletId: params.outletId },
    });
    if (!r) throw notFound('Reservation not found.');

    if (!params.from.includes(r.status)) {
      throw new AppError(
        409,
        'INVALID_RESERVATION_TRANSITION',
        `A ${r.status.toLowerCase()} reservation cannot be ${params.to.toLowerCase()}.`,
        { status: r.status },
      );
    }

    await params.check?.(tx, r);

    const timestampField =
      params.to === 'CANCELLED'
        ? { cancelledAt: new Date() }
        : params.to === 'COMPLETED'
          ? { completedAt: new Date() }
          : params.to === 'EXPIRED'
            ? { expiredAt: new Date() }
            : {};

    const decisionField =
      params.to === 'CONFIRMED' || params.to === 'REJECTED'
        ? { decidedByUserId: params.actor.userId, decidedAt: new Date(), decisionReason: params.reason ?? null }
        : {};

    const { count } = await tx.tableReservation.updateMany({
      where: { id: r.id, version: r.version, status: r.status },
      data: { status: params.to, version: { increment: 1 }, ...timestampField, ...decisionField },
    });
    if (count === 0)
      throw new AppError(409, 'RESERVATION_CHANGED', 'This reservation just changed. Reload and try again.');

    await tx.reservationStatusHistory.create({
      data: {
        reservationId: r.id,
        fromStatus: r.status,
        toStatus: params.to,
        actorUserId: params.actor.userId,
        actorRole: params.actor.role,
        reason: params.reason ?? null,
      },
    });

    if (params.actor.role !== 'STUDENT') {
      await recordAudit(tx, {
        actor: { type: 'USER', userId: params.actor.userId },
        action: `RESERVATION_${params.to}`,
        entityType: 'TableReservation',
        entityId: r.id,
        metadata: { from: r.status, reason: params.reason ?? null },
      });
    }

    return toReservation((await loadReservation(tx, { id: r.id }))!);
  });
}

export function confirmReservation(
  db: Database,
  outletId: string,
  reservationId: string,
  managerUserId: string,
  reason?: string,
) {
  return transition(db, {
    outletId,
    reservationId,
    from: ['PENDING'],
    to: 'CONFIRMED',
    actor: { userId: managerUserId, role: 'MANAGER' },
    reason,
    check: async (tx, r) => {
      if (r.startsAt.getTime() <= Date.now()) {
        throw new AppError(409, 'RESERVATION_STARTED', 'The reservation time has already passed.');
      }
      // Re-check overlap against already-CONFIRMED reservations when confirming
      if (r.tableId) {
        const clash = await tx.tableReservation.count({
          where: {
            tableId: r.tableId,
            status: 'CONFIRMED',
            startsAt: { lt: r.endsAt },
            endsAt: { gt: r.startsAt },
            NOT: { id: r.id },
          },
        });
        if (clash > 0) {
          throw new AppError(409, 'TABLE_UNAVAILABLE', 'Another confirmed reservation already holds that table in this time slot.');
        }
      }
    },
  });
}

export function rejectReservation(
  db: Database,
  outletId: string,
  reservationId: string,
  managerUserId: string,
  reason: string,
) {
  if (!reason || reason.trim().length < 3) {
    throw new AppError(400, 'REASON_REQUIRED', 'Please provide a reason for the rejection.');
  }
  return transition(db, {
    outletId,
    reservationId,
    from: ['PENDING'],
    to: 'REJECTED',
    actor: { userId: managerUserId, role: 'MANAGER' },
    reason,
  });
}

export function completeReservation(
  db: Database,
  outletId: string,
  reservationId: string,
  managerUserId: string,
) {
  return transition(db, {
    outletId,
    reservationId,
    from: ['CONFIRMED'],
    to: 'COMPLETED',
    actor: { userId: managerUserId, role: 'MANAGER' },
    check: async (_tx, r) => {
      if (r.startsAt.getTime() > Date.now()) {
        throw new AppError(409, 'RESERVATION_NOT_STARTED', 'Cannot complete a reservation before it begins.');
      }
    },
  });
}

// ─── System job: expire stale reservations ────────────────────────────────────

/**
 * Marks PENDING or CONFIRMED reservations whose start time has passed as EXPIRED.
 * Intended to be called periodically by a background worker.
 * Returns the number of reservations expired.
 */
export async function expireReservations(db: Database, now = new Date()): Promise<number> {
  const stale = await db.tableReservation.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED'] },
      startsAt: { lte: now },
    },
    select: { id: true, status: true },
    take: 500,
  });

  if (stale.length === 0) return 0;

  await db.$transaction(async (tx) => {
    for (const r of stale) {
      const { count } = await tx.tableReservation.updateMany({
        where: { id: r.id, status: r.status },
        data: { status: 'EXPIRED', expiredAt: now, version: { increment: 1 } },
      });
      if (count === 0) continue; // already transitioned by another process
      await tx.reservationStatusHistory.create({
        data: {
          reservationId: r.id,
          fromStatus: r.status,
          toStatus: 'EXPIRED',
          actorUserId: null,
          actorRole: null,
          reason: 'Reservation start time passed without confirmation.',
        },
      });
    }
  });

  return stale.length;
}
