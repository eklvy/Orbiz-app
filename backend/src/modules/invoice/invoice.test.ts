import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import {
  student,
  fund,
  menu,
  addToCart,
  placeOrder,
} from '../../tests/commerce.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const H = { 'X-Requested-With': 'CampusCart' };
const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });

function makeApp() {
  return buildTestApp({ config });
}

async function signedIn(email: string) {
  const agent = request.agent(makeApp());
  await devLogin(agent, email);
  return agent;
}

async function adminAgent() {
  const bootstrap = request.agent(makeApp());
  await devLogin(bootstrap, 'admin@example.com');
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
  await prisma.userRole.upsert({
    where: { userId_role: { userId: user.id, role: 'ADMIN' } },
    create: { userId: user.id, role: 'ADMIN', grantedVia: 'ADMIN' },
    update: { revokedAt: null },
  });
  const agent = request.agent(makeApp());
  await devLogin(agent, 'admin@example.com');
  return agent;
}

beforeEach(async () => {
  await resetDatabase();
});

// ─── Authentication & authorisation ──────────────────────────────────────────

describe('invoice access control', () => {
  it('returns 401 when unauthenticated', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    await request(makeApp()).get(`/api/v1/orders/${fakeId}/invoice`).set(H).expect(401);
  });

  it('returns 404 for a non-existent order', async () => {
    const s = await signedIn('u@example.com');
    const fakeId = '00000000-0000-0000-0000-000000000001';
    await s.get(`/api/v1/orders/${fakeId}/invoice`).set(H).expect(404);
  });

  it("returns 404 when requesting another user's order invoice", async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const bob = await signedIn('bob@example.com');
    await bob.get(`/api/v1/orders/${orderId}/invoice`).set(H).expect(404);
  });

  it('returns 409 for an unpaid order (PENDING_COUNTER)', async () => {
    const s = await student();
    const m = await menu();
    await addToCart(s, m.puff.id, 1);
    const orderRes = await placeOrder(s, 'COUNTER', 3500).expect(201);
    const orderId = orderRes.body.order.id as string;

    await s.get(`/api/v1/orders/${orderId}/invoice`).set(H).expect(409);
  });
});

// ─── Successful invoice generation ───────────────────────────────────────────

describe('invoice PDF generation', () => {
  it('returns a PDF for a WALLET paid order', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const res = await s.get(`/api/v1/orders/${orderId}/invoice`).set(H).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.pdf');
    // PDF magic bytes: %PDF-
    const body = res.body as Buffer;
    expect(body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('returns a PDF for a COUNTER paid order', async () => {
    const s = await student();
    const m = await menu();
    await addToCart(s, m.puff.id, 1);
    const orderRes = await placeOrder(s, 'COUNTER', 3500).expect(201);
    const orderId = orderRes.body.order.id as string;

    // Simulate counter payment
    const mgrUser = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr@example.com' } });
    await prisma.staffAssignment.create({
      data: { userId: mgrUser.id, outletId: m.outlet.id, role: 'POS' },
    });
    const mgr = request.agent(makeApp());
    await devLogin(mgr, 'mgr@example.com');
    await mgr
      .post(`/api/v1/staff/outlets/${m.outlet.id}/orders/${orderId}/counter-payment`)
      .set(H)
      .send({ amountPaise: 3500, note: '' })
      .expect(201);

    const res = await s.get(`/api/v1/orders/${orderId}/invoice`).set(H).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

// ─── Admin invoice access ─────────────────────────────────────────────────────

describe('admin invoice access', () => {
  it("admin can download any user's invoice", async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const admin = await adminAgent();
    const res = await admin
      .get(`/api/v1/admin/orders/${orderId}/invoice`)
      .set(H)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('non-admin cannot use the admin invoice endpoint', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const bob = await signedIn('bob@example.com');
    await bob.get(`/api/v1/admin/orders/${orderId}/invoice`).set(H).expect(403);
  });
});
