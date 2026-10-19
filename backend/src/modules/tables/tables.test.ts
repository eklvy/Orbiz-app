import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { makeOutlet } from '../../tests/fixtures.js';
import { signIn, staffFor } from '../../tests/staff.js';
import type { Agent } from '../../tests/commerce.js';
import { staffApp } from '../../tests/staff.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const headers = { 'X-Requested-With': 'CampusCart' };

let outlet: { id: string; slug: string };
let manager: Agent;
let cashier: Agent;
let student: Agent;

const staffUrl = (path: string) => `/api/v1/staff/outlets/${outlet.id}/tables${path}`;
const publicUrl = (path: string) => `/api/v1/outlets/${outlet.slug}/tables${path}`;

const get = (agent: Agent, url: string) => agent.get(url).set(headers);
const post = (agent: Agent, url: string, body?: object) =>
  body ? agent.post(url).set(headers).send(body) : agent.post(url).set(headers);
const patch = (agent: Agent, url: string, body: object) =>
  agent.patch(url).set(headers).send(body);
const del = (agent: Agent, url: string) => agent.delete(url).set(headers);

beforeEach(async () => {
  await resetDatabase();
  outlet = await makeOutlet({ status: 'OPEN' });
  ({ manager, cashier } = await staffFor(outlet.id));
  student = await signIn('student@example.com', staffApp);
  // provision the student account (dev-login creates it)
  await staffApp; // app is already built
});

// ─── Table creation ────────────────────────────────────────────────────────────

describe('creating tables', () => {
  it('allows MANAGER to create a table', async () => {
    const res = await post(manager, staffUrl('/'), {
      label: 'Table 1',
      capacity: 4,
      notes: 'Window seat',
    }).expect(201);
    expect(res.body.table.label).toBe('Table 1');
    expect(res.body.table.capacity).toBe(4);
    expect(res.body.table.notes).toBe('Window seat');
    expect(res.body.table.occupancy).toBe(0);
    expect(res.body.table.status).toBe('AVAILABLE');
    expect(res.body.table.dataSource).toBe('MANUAL');
  });

  it('rejects POS (cashier) creating a table', async () => {
    await post(cashier, staffUrl('/'), { label: 'Table 1', capacity: 4 }).expect(403);
  });

  it('rejects unauthenticated creation', async () => {
    const anon = (await import('supertest')).default(staffApp);
    await anon.post(staffUrl('/')).set(headers).send({ label: 'T', capacity: 2 }).expect(401);
  });

  it('rejects a student creating a table', async () => {
    await post(student, staffUrl('/'), { label: 'T', capacity: 2 }).expect(403);
  });

  it('enforces unique label per outlet', async () => {
    await post(manager, staffUrl('/'), { label: 'Table A', capacity: 4 }).expect(201);
    const res = await post(manager, staffUrl('/'), { label: 'Table A', capacity: 2 }).expect(409);
    expect(res.body.error.code).toBe('DUPLICATE_LABEL');
  });

  it('rejects capacity < 1', async () => {
    await post(manager, staffUrl('/'), { label: 'T', capacity: 0 }).expect(400);
  });
});

// ─── Listing and visibility ────────────────────────────────────────────────────

describe('listing tables', () => {
  it('public endpoint returns active tables with MANUAL data source', async () => {
    await post(manager, staffUrl('/'), { label: 'T1', capacity: 2 }).expect(201);
    const res = await get(student, publicUrl('/')).expect(200);
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.tables[0].dataSource).toBe('MANUAL');
    // Public view never exposes notes or isActive flag
    expect(res.body.tables[0].notes).toBeUndefined();
    expect(res.body.tables[0].isActive).toBeUndefined();
  });

  it('public endpoint hides inactive tables', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 2 }).expect(201);
    await del(manager, staffUrl(`/${body.table.id}`)).expect(204);
    const res = await get(student, publicUrl('/')).expect(200);
    expect(res.body.tables).toHaveLength(0);
  });

  it('staff endpoint returns all tables including inactive', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 2 }).expect(201);
    await del(manager, staffUrl(`/${body.table.id}`)).expect(204);
    const res = await get(manager, staffUrl('/')).expect(200);
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.tables[0].isActive).toBe(false);
  });

  it('POS can list tables', async () => {
    await post(manager, staffUrl('/'), { label: 'T1', capacity: 2 }).expect(201);
    await get(cashier, staffUrl('/')).expect(200);
  });
});

// ─── Occupancy updates ─────────────────────────────────────────────────────────

describe('occupancy updates (manual)', () => {
  let tableId: string;

  beforeEach(async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 4 }).expect(201);
    tableId = body.table.id;
  });

  it('MANAGER can update occupancy', async () => {
    const res = await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 3,
      status: 'OCCUPIED',
    }).expect(200);
    expect(res.body.table.occupancy).toBe(3);
    expect(res.body.table.status).toBe('OCCUPIED');
    expect(res.body.table.occupancyUpdatedAt).not.toBeNull();
  });

  it('POS can update occupancy', async () => {
    const res = await patch(cashier, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 2,
      status: 'OCCUPIED',
    }).expect(200);
    expect(res.body.table.occupancy).toBe(2);
  });

  it('rejects occupancy exceeding capacity', async () => {
    const res = await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 5, // capacity is 4
      status: 'OCCUPIED',
    }).expect(409);
    expect(res.body.error.code).toBe('OCCUPANCY_EXCEEDS_CAPACITY');
  });

  it('rejects AVAILABLE status with non-zero occupancy', async () => {
    const res = await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 2,
      status: 'AVAILABLE',
    }).expect(400);
    expect(res.body.error.code).toBe('OCCUPANCY_STATUS_MISMATCH');
  });

  it('rejects OCCUPIED status with zero occupancy', async () => {
    const res = await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 0,
      status: 'OCCUPIED',
    }).expect(400);
    expect(res.body.error.code).toBe('OCCUPANCY_STATUS_MISMATCH');
  });

  it('allows marking a table UNAVAILABLE with 0 occupancy', async () => {
    const res = await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 0,
      status: 'UNAVAILABLE',
    }).expect(200);
    expect(res.body.table.status).toBe('UNAVAILABLE');
  });

  it('students cannot update occupancy', async () => {
    await patch(student, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 1,
      status: 'OCCUPIED',
    }).expect(403);
  });
});

// ─── Capacity constraint on update ────────────────────────────────────────────

describe('capacity update constraints', () => {
  it('rejects reducing capacity below current occupancy', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 6 }).expect(201);
    const tableId = body.table.id;

    // Set occupancy to 4
    await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 4,
      status: 'OCCUPIED',
    }).expect(200);

    // Try to lower capacity to 3 (below current occupancy of 4)
    const res = await patch(manager, staffUrl(`/${tableId}`), { capacity: 3 }).expect(409);
    expect(res.body.error.code).toBe('CAPACITY_BELOW_OCCUPANCY');
  });

  it('allows reducing capacity to equal current occupancy', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 6 }).expect(201);
    const tableId = body.table.id;
    await patch(manager, staffUrl(`/${tableId}/occupancy`), {
      occupancy: 4,
      status: 'OCCUPIED',
    }).expect(200);
    // Reduce capacity to exactly 4 — should be allowed
    const res = await patch(manager, staffUrl(`/${tableId}`), { capacity: 4 }).expect(200);
    expect(res.body.table.capacity).toBe(4);
  });
});

// ─── Table deactivation ────────────────────────────────────────────────────────

describe('deactivating tables', () => {
  it('MANAGER can deactivate; deactivated table disappears from public list', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 4 }).expect(201);
    await del(manager, staffUrl(`/${body.table.id}`)).expect(204);

    const pub = await get(student, publicUrl('/')).expect(200);
    expect(pub.body.tables).toHaveLength(0);
  });

  it('POS cannot deactivate', async () => {
    const { body } = await post(manager, staffUrl('/'), { label: 'T1', capacity: 4 }).expect(201);
    await del(cashier, staffUrl(`/${body.table.id}`)).expect(403);
  });
});

// ─── Cross-outlet isolation ────────────────────────────────────────────────────

describe('cross-outlet isolation', () => {
  it('cannot read or modify a table from another outlet', async () => {
    const other = await makeOutlet({ status: 'OPEN' });
    const otherTable = await prisma.diningTable.create({
      data: { outletId: other.id, label: 'T-X', capacity: 4 },
    });

    // PATCH another outlet's table through this outlet's URL → 404
    await patch(manager, staffUrl(`/${otherTable.id}`), { label: 'Hacked' }).expect(404);
  });
});
