/**
 * Tests for imageUrl field on outlets and menu items.
 * Verifies that valid URLs are accepted, invalid URLs are rejected,
 * and unrelated unknown fields are still rejected by .strict().
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { assign, makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { grantRole } from '../users/roles.service.js';
import { prisma } from '../../tests/db.js';

const config = testConfig({
  MANAGER_ALLOWED_EMAILS: 'manager@example.com',
  POS_ALLOWED_EMAILS: '',
});
const app = buildTestApp({ config });

const H = { 'X-Requested-With': 'CampusCart' };

async function agentFor(email: string) {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

type Agent = Awaited<ReturnType<typeof agentFor>>;

let admin: Agent;
let manager: Agent;
let outlet: Awaited<ReturnType<typeof makeOutlet>>;
let category: Awaited<ReturnType<typeof makeCategory>>;
let item: Awaited<ReturnType<typeof makeItem>>;

beforeEach(async () => {
  await resetDatabase();
  admin = await agentFor('admin@example.com');
  await grantRole(prisma, {
    email: 'admin@example.com',
    role: 'ADMIN',
    actor: { type: 'CLI' },
    lists: config,
  });
  outlet = await makeOutlet({ name: 'Test Outlet', status: 'OPEN' });
  category = await makeCategory(outlet.id, 'Drinks');
  item = await makeItem(outlet.id, category.id, { name: 'Chai', pricePaise: 2000 });
  manager = await agentFor('manager@example.com');
  await assign('manager@example.com', outlet.id, 'MANAGER');
});

// ─── Outlet imageUrl ──────────────────────────────────────────────────────────

describe('imageUrl on outlets', () => {
  it('creates an outlet with a valid imageUrl', async () => {
    const imageUrl = 'https://example.com/outlet.jpg';
    const res = await admin
      .post('/api/v1/admin/outlets')
      .set(H)
      .send({ name: 'Stall A', imageUrl })
      .expect(201);
    expect(res.body.outlet.imageUrl).toBe(imageUrl);
  });

  it('creates an outlet without imageUrl (defaults to null)', async () => {
    const res = await admin
      .post('/api/v1/admin/outlets')
      .set(H)
      .send({ name: 'Stall B' })
      .expect(201);
    expect(res.body.outlet.imageUrl).toBeNull();
  });

  it('rejects an invalid imageUrl on create', async () => {
    await admin
      .post('/api/v1/admin/outlets')
      .set(H)
      .send({ name: 'Stall C', imageUrl: 'not-a-url' })
      .expect(400);
  });

  it('still rejects unknown fields on outlet create', async () => {
    await admin
      .post('/api/v1/admin/outlets')
      .set(H)
      .send({ name: 'Stall D', unknownField: 'x' })
      .expect(400);
  });

  it('updates an outlet imageUrl via PATCH', async () => {
    const imageUrl = 'https://cdn.example.com/updated.png';
    const res = await admin
      .patch(`/api/v1/admin/outlets/${outlet.id}`)
      .set(H)
      .send({ imageUrl })
      .expect(200);
    expect(res.body.outlet.imageUrl).toBe(imageUrl);
  });

  it('clears imageUrl by setting null via PATCH', async () => {
    await prisma.outlet.update({ where: { id: outlet.id }, data: { imageUrl: 'https://example.com/old.jpg' } });
    const res = await admin
      .patch(`/api/v1/admin/outlets/${outlet.id}`)
      .set(H)
      .send({ imageUrl: null })
      .expect(200);
    expect(res.body.outlet.imageUrl).toBeNull();
  });

  it('rejects an invalid imageUrl on update', async () => {
    await admin
      .patch(`/api/v1/admin/outlets/${outlet.id}`)
      .set(H)
      .send({ imageUrl: 'definitely-not-a-url' })
      .expect(400);
  });

  it('still rejects unknown fields on outlet update', async () => {
    await admin
      .patch(`/api/v1/admin/outlets/${outlet.id}`)
      .set(H)
      .send({ sneakyField: true })
      .expect(400);
  });
});

// ─── MenuItem imageUrl ────────────────────────────────────────────────────────

describe('imageUrl on menu items', () => {
  it('creates a menu item with a valid imageUrl', async () => {
    const imageUrl = 'https://example.com/chai.jpg';
    const res = await manager
      .post(`/api/v1/staff/outlets/${outlet.id}/items`)
      .set(H)
      .send({
        categoryId: category.id,
        name: 'Samosa',
        pricePaise: 1500,
        imageUrl,
      })
      .expect(201);
    expect(res.body.item.imageUrl).toBe(imageUrl);
  });

  it('creates a menu item without imageUrl (defaults to null)', async () => {
    const res = await manager
      .post(`/api/v1/staff/outlets/${outlet.id}/items`)
      .set(H)
      .send({ categoryId: category.id, name: 'Plain Rice', pricePaise: 3000 })
      .expect(201);
    expect(res.body.item.imageUrl).toBeNull();
  });

  it('rejects an invalid imageUrl on item create', async () => {
    await manager
      .post(`/api/v1/staff/outlets/${outlet.id}/items`)
      .set(H)
      .send({
        categoryId: category.id,
        name: 'Bad Item',
        pricePaise: 1000,
        imageUrl: 'not-a-url',
      })
      .expect(400);
  });

  it('still rejects unknown fields on item create', async () => {
    await manager
      .post(`/api/v1/staff/outlets/${outlet.id}/items`)
      .set(H)
      .send({
        categoryId: category.id,
        name: 'Sneaky',
        pricePaise: 1000,
        hackField: 'boom',
      })
      .expect(400);
  });

  it('updates item imageUrl via PATCH', async () => {
    const imageUrl = 'https://example.com/item-updated.webp';
    const res = await manager
      .patch(`/api/v1/staff/outlets/${outlet.id}/items/${item.id}`)
      .set(H)
      .send({ imageUrl })
      .expect(200);
    expect(res.body.item.imageUrl).toBe(imageUrl);
  });

  it('clears item imageUrl by setting null via PATCH', async () => {
    await prisma.menuItem.update({ where: { id: item.id }, data: { imageUrl: 'https://example.com/old.jpg' } });
    const res = await manager
      .patch(`/api/v1/staff/outlets/${outlet.id}/items/${item.id}`)
      .set(H)
      .send({ imageUrl: null })
      .expect(200);
    expect(res.body.item.imageUrl).toBeNull();
  });

  it('rejects an invalid imageUrl on item update', async () => {
    await manager
      .patch(`/api/v1/staff/outlets/${outlet.id}/items/${item.id}`)
      .set(H)
      .send({ imageUrl: 'not-a-url' })
      .expect(400);
  });

  it('still rejects unknown fields on item update', async () => {
    await manager
      .patch(`/api/v1/staff/outlets/${outlet.id}/items/${item.id}`)
      .set(H)
      .send({ outletId: 'some-other-id' })
      .expect(400);
  });

  it('imageUrl is returned in the public outlet menu', async () => {
    const imageUrl = 'https://example.com/public.jpg';
    await manager
      .patch(`/api/v1/staff/outlets/${outlet.id}/items/${item.id}`)
      .set(H)
      .send({ imageUrl })
      .expect(200);

    const menu = await request(app)
      .get(`/api/v1/outlets/${outlet.slug}/menu`)
      .set(H)
      .expect(200);
    const chai = menu.body.items.find((i: { name: string }) => i.name === 'Chai');
    expect(chai.imageUrl).toBe(imageUrl);
  });
});
