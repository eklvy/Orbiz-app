import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import {
  cancelReservation,
  confirmReservation,
  completeReservation,
  createReservation,
  getMyReservation,
  getOutletReservation,
  listMyReservations,
  listOutletReservations,
  rejectReservation,
} from './reservations.service.js';
import type { ReservationStatus } from '../../generated/prisma/enums.js';

const reservationStatusSchema = z.enum([
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
  'EXPIRED',
]);

const createReservationBody = z
  .object({
    outletId: z.uuid(),
    tableId: z.uuid().optional(),
    partySize: z.number().int().min(1).max(50),
    startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    endsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    notes: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((b) => b.endsAt > b.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

const cancelBody = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();

const reasonBody = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();

const statusQuery = z.object({
  status: reservationStatusSchema.optional(),
});

function idParam(req: Request, name: string) {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound('Reservation not found');
  return parsed.data;
}

// ─── Student: own reservations ────────────────────────────────────────────────

/** /api/v1/reservations — a student's own table reservations. */
export function reservationsRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));

  /** GET / — list my reservations, newest-first. */
  router.get('/', async (req, res) => {
    res.json({ reservations: await listMyReservations(db, req.auth!.user.id) });
  });

  /** POST / — create a new reservation. */
  router.post('/', async (req, res) => {
    const body = createReservationBody.parse(req.body);
    const reservation = await createReservation(db, req.auth!.user.id, body);
    res.status(201).json({ reservation });
  });

  /** GET /:reservationId — get one of my reservations. */
  router.get('/:reservationId', async (req, res) => {
    const reservationId = idParam(req, 'reservationId');
    res.json({ reservation: await getMyReservation(db, req.auth!.user.id, reservationId) });
  });

  /** POST /:reservationId/cancel — cancel a PENDING or CONFIRMED reservation. */
  router.post('/:reservationId/cancel', async (req, res) => {
    const reservationId = idParam(req, 'reservationId');
    const { reason } = cancelBody.parse(req.body);
    const reservation = await cancelReservation(db, req.auth!.user.id, reservationId, reason);
    res.json({ reservation });
  });

  return router;
}

// ─── Staff: manage reservations for an outlet ─────────────────────────────────

/** /api/v1/staff/outlets/:outletId/reservations */
export function staffReservationsRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER', 'POS'));

  const outletOf = (req: Request) => idParam(req, 'outletId');

  /** GET / — list reservations, optionally filtered by status. */
  router.get('/', async (req, res) => {
    const { status } = statusQuery.parse(req.query);
    res.json({
      reservations: await listOutletReservations(db, outletOf(req), status as ReservationStatus | undefined),
    });
  });

  /** GET /:reservationId — get a specific reservation. */
  router.get('/:reservationId', async (req, res) => {
    res.json({
      reservation: await getOutletReservation(db, outletOf(req), idParam(req, 'reservationId')),
    });
  });

  /** POST /:reservationId/confirm — MANAGER confirms a PENDING reservation. */
  router.post('/:reservationId/confirm', requireOutletRole(db, 'MANAGER'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body ?? {});
    const reservation = await confirmReservation(
      db,
      outletOf(req),
      idParam(req, 'reservationId'),
      req.auth!.user.id,
      reason,
    );
    res.json({ reservation });
  });

  /** POST /:reservationId/reject — MANAGER rejects a PENDING reservation (reason required). */
  router.post('/:reservationId/reject', requireOutletRole(db, 'MANAGER'), async (req, res) => {
    const { reason } = reasonBody.parse(req.body ?? {});
    const reservation = await rejectReservation(
      db,
      outletOf(req),
      idParam(req, 'reservationId'),
      req.auth!.user.id,
      reason ?? '',
    );
    res.json({ reservation });
  });

  /** POST /:reservationId/complete — MANAGER marks a CONFIRMED reservation as completed. */
  router.post('/:reservationId/complete', requireOutletRole(db, 'MANAGER'), async (req, res) => {
    const reservation = await completeReservation(
      db,
      outletOf(req),
      idParam(req, 'reservationId'),
      req.auth!.user.id,
    );
    res.json({ reservation });
  });

  return router;
}
