import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../../tests/db.js';
import { menu, type Agent } from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { staffApp, staffFor } from '../../tests/staff.js';

const H = { 'X-Requested-With': 'CampusCart' };
const anon = () => request(staffApp);

const outletMenu = (slug: string, query = '') =>
  anon().get(`/api/v1/outlets/${slug}/menu${query}`).set(H);

const campusMenu = (query = '') => anon().get(`/api/v1/menu${query}`).set(H);

const patchItem = (agent: Agent, outletId: string, itemId: string, body: object) =>
  agent.patch(`/api/v1/staff/outlets/${outletId}/items/${itemId}`).set(H).send(body);

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;

beforeEach(async () => {
  await resetDatabase();
  m = await menu();
  ({ manager } = await staffFor(m.outlet.id, staffApp));
});

// ─── Spice level on item CRUD ──────────────────────────────────────────────────

describe('spiceLevel field', () => {
  it('is null by default on a new item', async () => {
    const res = await outletMenu(m.outlet.slug).expect(200);
    const chai = res.body.items.find((i: { name: string }) => i.name === 'Chai');
    expect(chai).toBeDefined();
    expect(chai.spiceLevel).toBeNull();
  });

  it('manager can set spiceLevel via PATCH', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: 'HOT' }).expect(200);

    const res = await outletMenu(m.outlet.slug).expect(200);
    const chai = res.body.items.find((i: { name: string }) => i.name === 'Chai');
    expect(chai.spiceLevel).toBe('HOT');
  });

  it('manager can clear spiceLevel by setting null', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: 'MEDIUM' }).expect(200);
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: null }).expect(200);

    const res = await outletMenu(m.outlet.slug).expect(200);
    const chai = res.body.items.find((i: { name: string }) => i.name === 'Chai');
    expect(chai.spiceLevel).toBeNull();
  });

  it('rejects an invalid spiceLevel value', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: 'EXTRA_HOT' }).expect(422);
  });

  it('spiceLevel is returned in campus menu', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: 'MILD' }).expect(200);

    const res = await campusMenu(`?outletId=${m.outlet.id}`).expect(200);
    const chai = res.body.items.find((i: { name: string }) => i.name === 'Chai');
    expect(chai.spiceLevel).toBe('MILD');
  });
});

// ─── Spice level filter ────────────────────────────────────────────────────────

describe('spiceLevel filter', () => {
  beforeEach(async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { spiceLevel: 'HOT' });
    await patchItem(manager, m.outlet.id, m.puff.id, { spiceLevel: 'MILD' });
  });

  it('outlet menu: filter by HOT returns only hot items', async () => {
    const res = await outletMenu(m.outlet.slug, '?spiceLevel=HOT').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Chai');
  });

  it('outlet menu: filter by MILD returns only mild items', async () => {
    const res = await outletMenu(m.outlet.slug, '?spiceLevel=MILD').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Puff');
  });

  it('outlet menu: filter by MEDIUM returns no items (none set to MEDIUM)', async () => {
    const res = await outletMenu(m.outlet.slug, '?spiceLevel=MEDIUM').expect(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('campus menu: filter by HOT returns only hot items', async () => {
    const res = await campusMenu(`?spiceLevel=HOT`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].name).toBe('Chai');
  });

  it('rejects unknown spiceLevel query value', async () => {
    await outletMenu(m.outlet.slug, '?spiceLevel=FIRE').expect(422);
  });

  it('no filter returns all items', async () => {
    const res = await outletMenu(m.outlet.slug).expect(200);
    expect(res.body.items).toHaveLength(2);
  });
});

// ─── Items without spiceLevel not broken ──────────────────────────────────────

describe('items with null spiceLevel', () => {
  it('appear normally without spiceLevel filter', async () => {
    const outlet = await makeOutlet({ status: 'OPEN' });
    const cat = await makeCategory(outlet.id);
    await makeItem(outlet.id, cat.id, { name: 'Plain Rice' });

    const res = await campusMenu(`?outletId=${outlet.id}`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].spiceLevel).toBeNull();
  });

  it('are excluded when filtering by a specific spice level', async () => {
    const outlet = await makeOutlet({ status: 'OPEN' });
    const cat = await makeCategory(outlet.id);
    await makeItem(outlet.id, cat.id, { name: 'Plain Rice' });

    const res = await campusMenu(`?outletId=${outlet.id}&spiceLevel=MILD`).expect(200);
    expect(res.body.total).toBe(0);
  });
});
