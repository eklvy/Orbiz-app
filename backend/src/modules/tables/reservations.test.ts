import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffFor, staffApp } from '../../tests/staff.js';
import type { Agent } from '../../tests/commerce.js';
import { istDayOf, istMidnight } from '../scheduling/slots.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const H = { 'X-Requested-With': 'CampusCart' };

let outlet: { id: string; slug: string };
let manager: Agent;
let cashier: Agent;
let alice: Agent; // student
let bob: Agent;   // student
let n = 0;

const staffBase = () => `/api/v1/staff/outlets/${outlet.id}/reservations`;
const userBase = () => `/api/v1/reservations`;

const api = (agent: Agent, method: 'get' | 'post' | 'patch' | 'put', url: string, body?: object) => {
  const req = agent[method](url).set(H);
  return body ? req.send(body) : req;
};

// Build a datetime (IST) n days ahead at the given hour
const at = (daysAhead: number, hour: number) => {
  const day = istDayOf(Date.now() + daysAhead * 86_400_000);
  return new Date(istMidnight(day) + hour * 3_600_000).toISOString();
};

// Default reservation request (2 hours in the future, within outlet hours)
const validReq = (overrides: object = {}) => ({
  outletId: outlet.id,
  partySize: 2,
  startsAt: at(1, 12), // tomorrow noon IST
  endsAt: at(1, 13),   // tomorrow 1pm IST
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  outlet = await makeOutlet({ status: 'OPEN' });
  ({ manager, cashier } = await staffFor(outlet.id));
  alice = await signIn(`alice${n}@example.com`, staffApp);
  bob = await signIn(`bob${n}@example.com`, staffApp);

  // Configure outlet hours: open 9am–9pm every day
  await api(manager, 'put', `/api/v1/staff/outlets/${outlet.id}/schedule`, {
    leadMinutes: 30,
    slotMinutes: 15,
    daysAhead: 2,
    slotCapacity: null,
    hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensMinute: 9 * 60,   // 9am
      closesMinute: 21 * 60, // 9pm
    })),
  }).expect(200);
});

// ─── Creating reservations ─────────────────────────────────────────────────────

describe('creating a reservation', () => {
  it('creates a PENDING reservation for a student', async () => {
    const res = await api(alice, 'post', userBase(), validReq()).expect(201);
    expect(res.body.reservation.status).toBe('PENDING');
    expect(res.body.reservation.outlet.id).toBe(outlet.id);
    expect(res.body.reservation.partySize).toBe(2);
    expect(res.body.reservation.history).toHaveLength(1);
    expect(res.body.reservation.history[0].toStatus).toBe('PENDING');
  });

  it('rejects a non-student (manager) using the student endpoint', async () => {
    await api(manager, 'post', userBase(), validReq()).expect(403);
  });

  it('rejects unauthenticated request', async () => {
    const anon = (await import('supertest')).default(staffApp);
    await anon.post(userBase()).set(H).send(validReq()).expect(401);
  });

  it('rejects reservation at inactive outlet', async () => {
    const dead = await makeOutlet({ isActive: false });
    const res = await api(alice, 'post', userBase(), { ...validReq(), outletId: dead.id }).expect(409);
    expect(res.body.error.code).toBe('OUTLET_UNAVAILABLE');
  });

  it('rejects reservation less than 15 minutes ahead', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 65 * 60_000).toISOString(),
    }).expect(409);
    expect(res.body.error.code).toBe('TOO_SOON');
  });

  it('rejects reservation more than 30 days ahead', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      startsAt: at(31, 12),
      endsAt: at(31, 13),
    }).expect(409);
    expect(res.body.error.code).toBe('TOO_FAR');
  });

  it('rejects reservation exceeding 4 hours', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      startsAt: at(1, 10),
      endsAt: at(1, 15), // 5 hours
    }).expect(409);
    expect(res.body.error.code).toBe('DURATION_TOO_LONG');
  });

  it('rejects endsAt before startsAt', async () => {
    await api(alice, 'post', userBase(), {
      ...validReq(),
      startsAt: at(1, 13),
      endsAt: at(1, 12),
    }).expect(400);
  });

  it('rejects reservation outside outlet hours', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      startsAt: at(1, 7),  // 7am, before 9am open
      endsAt: at(1, 8),
    }).expect(409);
    expect(res.body.error.code).toBe('OUTSIDE_HOURS');
  });

  it('rejects reservation on a day with no outlet hours', async () => {
    // Remove hours completely
    await prisma.outletHours.deleteMany({ where: { outletId: outlet.id } });
    const res = await api(alice, 'post', userBase(), validReq()).expect(409);
    expect(res.body.error.code).toBe('OUTSIDE_HOURS');
  });
});

// ─── Table-specific reservations ──────────────────────────────────────────────

describe('reservations with a specific table', () => {
  let tableId: string;

  beforeEach(async () => {
    const row = await prisma.diningTable.create({
      data: { outletId: outlet.id, label: 'T1', capacity: 4 },
    });
    tableId = row.id;
  });

  it('accepts a reservation for a specific table within capacity', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId,
      partySize: 4,
    }).expect(201);
    expect(res.body.reservation.table.id).toBe(tableId);
  });

  it('rejects party size exceeding table capacity', async () => {
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId,
      partySize: 5, // table capacity is 4
    }).expect(409);
    expect(res.body.error.code).toBe('PARTY_TOO_LARGE');
  });

  it('rejects a table from a different outlet', async () => {
    const other = await makeOutlet({ status: 'OPEN' });
    const otherTable = await prisma.diningTable.create({
      data: { outletId: other.id, label: 'T-X', capacity: 4 },
    });
    const res = await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId: otherTable.id,
    }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ─── Overlapping bookings ──────────────────────────────────────────────────────

describe('overlapping reservation prevention', () => {
  let tableId: string;

  beforeEach(async () => {
    const row = await prisma.diningTable.create({
      data: { outletId: outlet.id, label: 'T1', capacity: 4 },
    });
    tableId = row.id;
  });

  it('prevents two reservations for the same table in the same slot', async () => {
    await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 12),
      endsAt: at(1, 13),
    }).expect(201);

    const res = await api(bob, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 12),
      endsAt: at(1, 13),
    }).expect(409);
    expect(res.body.error.code).toBe('TABLE_UNAVAILABLE');
  });

  it('prevents overlapping (partial overlap) reservations on same table', async () => {
    await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 12),
      endsAt: at(1, 14),
    }).expect(201);

    // Overlaps: starts during alice's booking
    const res = await api(bob, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 13),
      endsAt: at(1, 15),
    }).expect(409);
    expect(res.body.error.code).toBe('TABLE_UNAVAILABLE');
  });

  it('allows adjacent (non-overlapping) reservations on the same table', async () => {
    await api(alice, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 12),
      endsAt: at(1, 13),
    }).expect(201);

    // Starts exactly when alice's ends
    await api(bob, 'post', userBase(), {
      ...validReq(),
      tableId,
      startsAt: at(1, 13),
      endsAt: at(1, 14),
    }).expect(201);
  });

  it('allows same-time reservations on different tables', async () => {
    const t2 = await prisma.diningTable.create({
      data: { outletId: outlet.id, label: 'T2', capacity: 4 },
    });

    await api(alice, 'post', userBase(), {
      ...validReq(), tableId, startsAt: at(1, 12), endsAt: at(1, 13),
    }).expect(201);
    await api(bob, 'post', userBase(), {
      ...validReq(), tableId: t2.id, startsAt: at(1, 12), endsAt: at(1, 13),
    }).expect(201);
  });
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

describe('cancelling a reservation', () => {
  it('owner can cancel a PENDING reservation', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    const id = body.reservation.id;
    const res = await alice.post(`${userBase()}/${id}/cancel`).set(H).send({ reason: 'Change of plans' }).expect(200);
    expect(res.body.reservation.status).toBe('CANCELLED');
    expect(res.body.reservation.cancelledAt).not.toBeNull();
  });

  it('prevents another user from cancelling', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    await bob.post(`${userBase()}/${body.reservation.id}/cancel`).set(H).send({}).expect(404);
  });

  it('cannot cancel an already-cancelled reservation', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    const id = body.reservation.id;
    await alice.post(`${userBase()}/${id}/cancel`).set(H).send({}).expect(200);
    const res = await alice.post(`${userBase()}/${id}/cancel`).set(H).send({}).expect(409);
    expect(res.body.error.code).toBe('INVALID_RESERVATION_TRANSITION');
  });
});

// ─── Staff decisions ───────────────────────────────────────────────────────────

describe('staff decisions', () => {
  let reservationId: string;

  beforeEach(async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    reservationId = body.reservation.id;
  });

  it('MANAGER can confirm a PENDING reservation', async () => {
    const res = await manager
      .post(`${staffBase()}/${reservationId}/confirm`)
      .set(H)
      .send({})
      .expect(200);
    expect(res.body.reservation.status).toBe('CONFIRMED');
  });

  it('MANAGER can reject a PENDING reservation with reason', async () => {
    const res = await manager
      .post(`${staffBase()}/${reservationId}/reject`)
      .set(H)
      .send({ reason: 'Outlet fully booked.' })
      .expect(200);
    expect(res.body.reservation.status).toBe('REJECTED');
    expect(res.body.reservation.decisionReason).toBe('Outlet fully booked.');
  });

  it('rejection requires a reason', async () => {
    const res = await manager
      .post(`${staffBase()}/${reservationId}/reject`)
      .set(H)
      .send({ reason: 'ok' }) // too short
      .expect(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
  });

  it('POS cannot confirm or reject', async () => {
    await cashier.post(`${staffBase()}/${reservationId}/confirm`).set(H).send({}).expect(403);
    await cashier.post(`${staffBase()}/${reservationId}/reject`).set(H).send({ reason: 'Nope.' }).expect(403);
  });

  it('cannot confirm a REJECTED reservation', async () => {
    await manager.post(`${staffBase()}/${reservationId}/reject`).set(H).send({ reason: 'Outlet fully booked.' }).expect(200);
    const res = await manager.post(`${staffBase()}/${reservationId}/confirm`).set(H).send({}).expect(409);
    expect(res.body.error.code).toBe('INVALID_RESERVATION_TRANSITION');
  });

  it('MANAGER can complete a CONFIRMED reservation after start time', async () => {
    // Confirm it first
    await manager.post(`${staffBase()}/${reservationId}/confirm`).set(H).send({}).expect(200);

    // Directly set startsAt in the past so complete is allowed
    await prisma.tableReservation.update({
      where: { id: reservationId },
      data: { startsAt: new Date(Date.now() - 3_600_000) },
    });

    const res = await manager.post(`${staffBase()}/${reservationId}/complete`).set(H).send({}).expect(200);
    expect(res.body.reservation.status).toBe('COMPLETED');
    expect(res.body.reservation.completedAt).not.toBeNull();
  });

  it('cannot complete a reservation before start time', async () => {
    await manager.post(`${staffBase()}/${reservationId}/confirm`).set(H).send({}).expect(200);
    const res = await manager.post(`${staffBase()}/${reservationId}/complete`).set(H).send({}).expect(409);
    expect(res.body.error.code).toBe('RESERVATION_NOT_STARTED');
  });
});

// ─── Overlapping confirmed reservations ───────────────────────────────────────

describe('overlap re-check during confirmation', () => {
  let tableId: string;

  beforeEach(async () => {
    const row = await prisma.diningTable.create({
      data: { outletId: outlet.id, label: 'T1', capacity: 4 },
    });
    tableId = row.id;
  });

  it('rejects confirming a reservation that clashes with an already-confirmed one', async () => {
    // Alice and Bob both create PENDING reservations on the same table at the same time
    const { body: a } = await api(alice, 'post', userBase(), {
      ...validReq(), tableId, startsAt: at(1, 12), endsAt: at(1, 13),
    }).expect(201);
    const { body: b } = await api(bob, 'post', userBase(), {
      ...validReq(), tableId, startsAt: at(1, 12), endsAt: at(1, 13),
    }).expect(201); // both created successfully as PENDING

    // Manager confirms Alice's first
    await manager.post(`${staffBase()}/${a.reservation.id}/confirm`).set(H).send({}).expect(200);

    // Confirming Bob's should fail — same table already confirmed
    const res = await manager.post(`${staffBase()}/${b.reservation.id}/confirm`).set(H).send({}).expect(409);
    expect(res.body.error.code).toBe('TABLE_UNAVAILABLE');
  });
});

// ─── Listing reservations ──────────────────────────────────────────────────────

describe('listing reservations', () => {
  it('user only sees their own reservations', async () => {
    await api(alice, 'post', userBase(), validReq()).expect(201);
    await api(bob, 'post', userBase(), validReq()).expect(201);

    const res = await api(alice, 'get', userBase()).expect(200);
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0].outlet.id).toBe(outlet.id);
  });

  it('staff can list all reservations for their outlet', async () => {
    await api(alice, 'post', userBase(), validReq()).expect(201);
    await api(bob, 'post', userBase(), validReq()).expect(201);

    const res = await api(manager, 'get', staffBase()).expect(200);
    expect(res.body.reservations).toHaveLength(2);
  });

  it('staff can filter by status', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    await manager.post(`${staffBase()}/${body.reservation.id}/confirm`).set(H).send({}).expect(200);

    const confirmed = await manager.get(`${staffBase()}?status=CONFIRMED`).set(H).expect(200);
    expect(confirmed.body.reservations).toHaveLength(1);

    const pending = await manager.get(`${staffBase()}?status=PENDING`).set(H).expect(200);
    expect(pending.body.reservations).toHaveLength(0);
  });

  it('staff cannot see reservations for a different outlet', async () => {
    const other = await makeOutlet({ status: 'OPEN' });
    // Create manager for other outlet
    const { manager: otherManager } = await staffFor(other.id);

    await api(alice, 'post', userBase(), validReq()).expect(201);

    // otherManager requests reservations for outlet (not assigned to them)
    await otherManager.get(`/api/v1/staff/outlets/${outlet.id}/reservations`).set(H).expect(403);
  });
});

// ─── Expiry ────────────────────────────────────────────────────────────────────

describe('expire reservations', () => {
  it('expireReservations marks stale PENDING reservations EXPIRED', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    const id = body.reservation.id;

    // Backdate the reservation to the past
    await prisma.tableReservation.update({
      where: { id },
      data: { startsAt: new Date(Date.now() - 7_200_000) },
    });

    const { expireReservations } = await import('./reservations.service.js');
    const count = await expireReservations(prisma);
    expect(count).toBeGreaterThanOrEqual(1);

    const updated = await prisma.tableReservation.findUniqueOrThrow({ where: { id } });
    expect(updated.status).toBe('EXPIRED');
    expect(updated.expiredAt).not.toBeNull();
  });

  it('does not expire already-cancelled reservations', async () => {
    const { body } = await api(alice, 'post', userBase(), validReq()).expect(201);
    const id = body.reservation.id;
    await alice.post(`${userBase()}/${id}/cancel`).set(H).send({}).expect(200);

    await prisma.tableReservation.update({
      where: { id },
      data: { startsAt: new Date(Date.now() - 7_200_000) },
    });

    const { expireReservations } = await import('./reservations.service.js');
    await expireReservations(prisma);

    const updated = await prisma.tableReservation.findUniqueOrThrow({ where: { id } });
    expect(updated.status).toBe('CANCELLED'); // unchanged
  });
});
