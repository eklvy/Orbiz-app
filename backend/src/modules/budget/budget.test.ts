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
  post,
} from '../../tests/commerce.js';
import { monthBoundsUtc } from './budget.service.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const H = { 'X-Requested-With': 'CampusCart' };
const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });

function makeApp() {
  return buildTestApp({ config });
}

async function signedIn(email: string) {
  const app = makeApp();
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

async function adminAgent() {
  const app = makeApp();
  const bootstrap = request.agent(app);
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

// ─── monthBoundsUtc unit tests ────────────────────────────────────────────────

describe('monthBoundsUtc', () => {
  it('returns UTC boundaries for IST (UTC+5:30)', () => {
    // IST midnight on 2026-10-01 = 2026-09-30T18:30:00Z
    const { start, end } = monthBoundsUtc('Asia/Kolkata', new Date('2026-10-15T10:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    // IST midnight on 2026-11-01 = 2026-10-31T18:30:00Z
    expect(end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('handles month boundary correctly in UTC', () => {
    // UTC itself: midnight Jan 1 = Jan 1 00:00:00Z
    const { start, end } = monthBoundsUtc('UTC', new Date('2026-01-20T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('handles December to January rollover', () => {
    const { start, end } = monthBoundsUtc('UTC', new Date('2026-12-15T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a date near month start boundary in IST', () => {
    // 2026-10-01 01:00:00 IST = 2026-09-30T19:30:00Z — still October in IST
    const { start } = monthBoundsUtc('Asia/Kolkata', new Date('2026-09-30T19:30:00Z'));
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('treats 2026-09-30T18:00:00Z as September in IST', () => {
    // 2026-09-30T18:00:00Z = 2026-09-30T23:30:00 IST (still September)
    const { start, end } = monthBoundsUtc('Asia/Kolkata', new Date('2026-09-30T18:00:00Z'));
    // September start in IST = 2026-08-31T18:30:00Z
    expect(start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    // October start in IST = 2026-09-30T18:30:00Z
    expect(end.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
});

// ─── GET /me/budget ───────────────────────────────────────────────────────────

describe('GET /me/budget', () => {
  it('returns 401 when unauthenticated', async () => {
    await request(makeApp()).get('/api/v1/me/budget').set(H).expect(401);
  });

  it('returns null when no budget is set', async () => {
    const agent = await signedIn('u@example.com');
    const res = await agent.get('/api/v1/me/budget').set(H).expect(200);
    expect(res.body.budget).toBeNull();
  });
});

// ─── PUT /me/budget ───────────────────────────────────────────────────────────

describe('PUT /me/budget', () => {
  it('sets a budget cap and returns current spend', async () => {
    const agent = await signedIn('u@example.com');
    const res = await agent
      .put('/api/v1/me/budget')
      .set(H)
      .send({ limitPaise: 50000, timezone: 'UTC' })
      .expect(200);
    expect(res.body.budget.limitPaise).toBe(50000);
    expect(res.body.budget.timezone).toBe('UTC');
    expect(res.body.budget.spentPaise).toBe(0);
    expect(res.body.budget.remainingPaise).toBe(50000);
    expect(res.body.budget.utilizationPct).toBe(0);
  });

  it('rejects limitPaise below 100', async () => {
    const agent = await signedIn('u@example.com');
    await agent
      .put('/api/v1/me/budget')
      .set(H)
      .send({ limitPaise: 50 })
      .expect(400);
  });

  it('rejects invalid timezone', async () => {
    const agent = await signedIn('u@example.com');
    const res = await agent
      .put('/api/v1/me/budget')
      .set(H)
      .send({ limitPaise: 10000, timezone: 'Not/ATimezone' })
      .expect(400);
    expect(res.body.code).toBe('INVALID_TIMEZONE');
  });

  it('updates an existing budget', async () => {
    const agent = await signedIn('u@example.com');
    await agent.put('/api/v1/me/budget').set(H).send({ limitPaise: 10000 }).expect(200);
    const res = await agent
      .put('/api/v1/me/budget')
      .set(H)
      .send({ limitPaise: 20000 })
      .expect(200);
    expect(res.body.budget.limitPaise).toBe(20000);
  });
});

// ─── DELETE /me/budget ────────────────────────────────────────────────────────

describe('DELETE /me/budget', () => {
  it('removes the budget cap', async () => {
    const agent = await signedIn('u@example.com');
    await agent.put('/api/v1/me/budget').set(H).send({ limitPaise: 10000 }).expect(200);
    await agent.delete('/api/v1/me/budget').set(H).expect(204);
    const res = await agent.get('/api/v1/me/budget').set(H).expect(200);
    expect(res.body.budget).toBeNull();
  });

  it('returns 404 when no budget is set', async () => {
    const agent = await signedIn('u@example.com');
    await agent.delete('/api/v1/me/budget').set(H).expect(404);
  });
});

// ─── Monthly spend calculation ────────────────────────────────────────────────

describe('monthly spend reflects actual orders', () => {
  it('includes PAID wallet orders in spend', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1); // ₹20
    await placeOrder(s, 'WALLET', 2000).expect(201);

    await post(s, '/me/budget', { limitPaise: 100000, timezone: 'UTC' }).expect(200);

    const res = await post(s, '/me/budget', { limitPaise: 100000, timezone: 'UTC' }).expect(200);
    expect(res.body.budget.spentPaise).toBe(2000);
    expect(res.body.budget.remainingPaise).toBe(98000);
  });

  it('includes COUNTER orders with PAID status', async () => {
    const s = await student();
    const m = await menu();
    await addToCart(s, m.puff.id, 1); // ₹35
    const orderRes = await placeOrder(s, 'COUNTER', 3500).expect(201);
    const orderId = orderRes.body.order.id;

    // Simulate counter payment recorded by POS
    const managerApp = makeApp();
    const manager = request.agent(managerApp);
    await devLogin(manager, 'mgr@example.com');
    const mgrUser = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr@example.com' } });
    await prisma.staffAssignment.create({
      data: { userId: mgrUser.id, outletId: m.outlet.id, role: 'POS' },
    });
    const mgr2 = request.agent(makeApp());
    await devLogin(mgr2, 'mgr@example.com');
    await mgr2
      .post(`/api/v1/staff/outlets/${m.outlet.id}/orders/${orderId}/counter-payment`)
      .set(H)
      .send({ amountPaise: 3500, note: '' })
      .expect(201);

    await post(s, '/me/budget', { limitPaise: 100000, timezone: 'UTC' }).expect(200);
    const res = await s.get('/api/v1/me/budget').set(H).expect(200);
    expect(res.body.budget.spentPaise).toBe(3500);
  });

  it('excludes CANCELLED (VOID/REFUNDED) orders from spend', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1); // ₹20
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id;

    // Cancel it
    await post(s, `/orders/${orderId}/cancel`, {}).expect(200);

    await post(s, '/me/budget', { limitPaise: 100000, timezone: 'UTC' }).expect(200);
    const res = await s.get('/api/v1/me/budget').set(H).expect(200);
    // Cancelled wallet order is REFUNDED → paymentStatus changes, not PAID anymore
    expect(res.body.budget.spentPaise).toBe(0);
  });
});

// ─── Budget enforcement at checkout ──────────────────────────────────────────

describe('budget enforcement at checkout', () => {
  it('blocks an order that would exceed the monthly budget', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    // Set a tight budget: ₹15 (1500 paise), chai costs ₹20
    await post(s, '/me/budget', { limitPaise: 1500, timezone: 'UTC' }).expect(200);

    await addToCart(s, m.chai.id, 1); // ₹20 → exceeds ₹15 budget
    const res = await placeOrder(s, 'WALLET', 2000).expect(409);
    expect(res.body.code).toBe('BUDGET_EXCEEDED');
    expect(res.body.meta.limitPaise).toBe(1500);
    expect(res.body.meta.orderTotalPaise).toBe(2000);
  });

  it('allows an order that fits within the budget', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await post(s, '/me/budget', { limitPaise: 50000, timezone: 'UTC' }).expect(200);

    await addToCart(s, m.chai.id, 1); // ₹20
    await placeOrder(s, 'WALLET', 2000).expect(201);
  });

  it('accumulates spend across multiple orders in the same month', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await post(s, '/me/budget', { limitPaise: 3000, timezone: 'UTC' }).expect(200); // ₹30 budget

    await addToCart(s, m.chai.id, 1); // ₹20
    await placeOrder(s, 'WALLET', 2000).expect(201); // spent ₹20, ₹10 remaining

    await addToCart(s, m.chai.id, 1); // ₹20 — would exceed ₹10 remaining
    const res = await placeOrder(s, 'WALLET', 2000).expect(409);
    expect(res.body.code).toBe('BUDGET_EXCEEDED');
    expect(res.body.meta.spentPaise).toBe(2000);
    expect(res.body.meta.remainingPaise).toBe(1000);
  });

  it('does not enforce budget when none is set', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    // No budget set — order should succeed regardless of amount
    await addToCart(s, m.chai.id, 1);
    await placeOrder(s, 'WALLET', 2000).expect(201);
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe('access control', () => {
  it("users cannot read each other's budget", async () => {
    const alice = await signedIn('alice@example.com');
    await alice.put('/api/v1/me/budget').set(H).send({ limitPaise: 10000 }).expect(200);

    const bob = await signedIn('bob@example.com');
    // Bob can only see his own budget
    const res = await bob.get('/api/v1/me/budget').set(H).expect(200);
    expect(res.body.budget).toBeNull(); // Bob has no budget set
  });

  it("admin can read any user's budget", async () => {
    const alice = await signedIn('alice@example.com');
    await alice.put('/api/v1/me/budget').set(H).send({ limitPaise: 10000 }).expect(200);
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });

    const admin = await adminAgent();
    const res = await admin
      .get(`/api/v1/admin/users/${aliceUser.id}/budget`)
      .set(H)
      .expect(200);
    expect(res.body.budget.limitPaise).toBe(10000);
  });

  it("admin can set a budget for another user", async () => {
    const alice = await signedIn('alice@example.com');
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });

    const admin = await adminAgent();
    const res = await admin
      .put(`/api/v1/admin/users/${aliceUser.id}/budget`)
      .set(H)
      .send({ limitPaise: 25000 })
      .expect(200);
    expect(res.body.budget.limitPaise).toBe(25000);

    // Alice sees the admin-set budget
    const aliceRes = await alice.get('/api/v1/me/budget').set(H).expect(200);
    expect(aliceRes.body.budget.limitPaise).toBe(25000);
  });

  it("non-admin cannot read another user's budget via admin endpoint", async () => {
    await signedIn('alice@example.com');
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
    const bob = await signedIn('bob@example.com');
    await bob.get(`/api/v1/admin/users/${aliceUser.id}/budget`).set(H).expect(403);
  });
});
