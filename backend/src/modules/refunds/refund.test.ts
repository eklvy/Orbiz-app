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

async function managerAgent(outletId: string) {
  const mgrUser = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr@example.com' } });
  await prisma.userRole.upsert({
    where: { userId_role: { userId: mgrUser.id, role: 'MANAGER' } },
    create: { userId: mgrUser.id, role: 'MANAGER', grantedVia: 'ADMIN' },
    update: { revokedAt: null },
  });
  await prisma.staffAssignment.upsert({
    where: { userId_outletId_role: { userId: mgrUser.id, outletId, role: 'MANAGER' } },
    create: { userId: mgrUser.id, outletId, role: 'MANAGER' },
    update: {},
  });
  const agent = request.agent(makeApp());
  await devLogin(agent, 'mgr@example.com');
  return agent;
}

beforeEach(async () => {
  await resetDatabase();
});

// ─── Submit ───────────────────────────────────────────────────────────────────

describe('submitting a refund request', () => {
  it('returns 401 when unauthenticated', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    await request(makeApp())
      .post(`/api/v1/orders/${fakeId}/refund-request`)
      .set(H)
      .send({ amountPaise: 1000, reason: 'Wrong item delivered' })
      .expect(401);
  });

  it('returns 404 for a non-existent order', async () => {
    const s = await signedIn('u@example.com');
    const fakeId = '00000000-0000-0000-0000-000000000001';
    await s
      .post(`/api/v1/orders/${fakeId}/refund-request`)
      .set(H)
      .send({ amountPaise: 1000, reason: 'Wrong item delivered' })
      .expect(404);
  });

  it("returns 404 when trying to submit for another user's order", async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const bob = await signedIn('bob@example.com');
    await bob
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 1000, reason: 'Wrong item delivered' })
      .expect(404);
  });

  it('returns 409 for an unpaid (PENDING_COUNTER) order', async () => {
    const s = await student();
    const m = await menu();
    await addToCart(s, m.puff.id, 1);
    const orderRes = await placeOrder(s, 'COUNTER', 3500).expect(201);
    const orderId = orderRes.body.order.id as string;

    await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 3500, reason: 'Order never arrived at counter' })
      .expect(409);
  });

  it('successfully submits a refund request for a WALLET paid order', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const res = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    expect(res.body.refundRequest.status).toBe('PENDING');
    expect(res.body.refundRequest.amountPaise).toBe(2000);
    expect(res.body.refundRequest.orderId).toBe(orderId);
  });

  it('returns 400 for a reason that is too short', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Bad' })
      .expect(400);
  });

  it('rejects an amount exceeding the order total', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const res = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 99999, reason: 'Requesting more than the order total' })
      .expect(409);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_ELIGIBLE');
    expect(res.body.meta.maxRefundable).toBe(2000);
  });
});

// ─── Duplicate prevention ─────────────────────────────────────────────────────

describe('duplicate refund request prevention', () => {
  it('blocks a second request while one is PENDING', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);

    const res = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Second attempt at the same order' })
      .expect(409);
    expect(res.body.code).toBe('DUPLICATE_REFUND_REQUEST');
  });
});

// ─── Read own request ─────────────────────────────────────────────────────────

describe('GET /orders/:orderId/refund-request', () => {
  it('returns null when no request has been submitted', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const res = await s.get(`/api/v1/orders/${orderId}/refund-request`).set(H).expect(200);
    expect(res.body.refundRequest).toBeNull();
  });

  it('returns the submitted request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' });

    const res = await s.get(`/api/v1/orders/${orderId}/refund-request`).set(H).expect(200);
    expect(res.body.refundRequest.status).toBe('PENDING');
  });
});

// ─── Decide (approve / reject) ────────────────────────────────────────────────

describe('admin/manager deciding a refund request', () => {
  it('admin can approve a pending request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    const res = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'APPROVED', note: 'Valid complaint — approved for refund' })
      .expect(200);
    expect(res.body.refundRequest.status).toBe('APPROVED');
    expect(res.body.refundRequest.decisionNote).toBe('Valid complaint — approved for refund');
  });

  it('admin can reject a pending request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    const res = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'REJECTED', note: 'No valid reason provided' })
      .expect(200);
    expect(res.body.refundRequest.status).toBe('REJECTED');
  });

  it('cannot decide an already-decided request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const res = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'REJECTED' })
      .expect(409);
    expect(res.body.code).toBe('INVALID_REFUND_TRANSITION');
  });

  it('non-admin/manager cannot decide', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    const bob = await signedIn('bob@example.com');
    await bob
      .post(`/api/v1/admin/refund-requests/${fakeId}/decide`)
      .set(H)
      .send({ decision: 'APPROVED' })
      .expect(403);
  });
});

// ─── Process (wallet credit) ──────────────────────────────────────────────────

describe('processing a refund request', () => {
  it('credits the wallet when an APPROVED wallet request is processed', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    // Check wallet balance before
    const walletBefore = await s.get('/api/v1/wallet').set(H).expect(200);
    const balanceBefore = walletBefore.body.wallet.balancePaise as number;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'APPROVED' })
      .expect(200);

    const processRes = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/process`)
      .set(H)
      .expect(200);
    expect(processRes.body.refundRequest.status).toBe('PROCESSED');
    expect(processRes.body.refundRequest.processedAt).toBeTruthy();

    // Wallet should be credited
    const walletAfter = await s.get('/api/v1/wallet').set(H).expect(200);
    const balanceAfter = walletAfter.body.wallet.balancePaise as number;
    expect(balanceAfter).toBe(balanceBefore + 2000);
  });

  it('cannot process a PENDING (not yet approved) request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    const res = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/process`)
      .set(H)
      .expect(409);
    expect(res.body.code).toBe('INVALID_REFUND_TRANSITION');
  });

  it('cannot process a REJECTED request', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const admin = await adminAgent();
    await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'REJECTED' })
      .expect(200);

    const res = await admin
      .post(`/api/v1/admin/refund-requests/${requestId}/process`)
      .set(H)
      .expect(409);
    expect(res.body.code).toBe('INVALID_REFUND_TRANSITION');
  });

  it('non-admin cannot process (MANAGER role is insufficient)', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);
    await addToCart(s, m.chai.id, 1);
    const orderRes = await placeOrder(s, 'WALLET', 2000).expect(201);
    const orderId = orderRes.body.order.id as string;

    const submitRes = await s
      .post(`/api/v1/orders/${orderId}/refund-request`)
      .set(H)
      .send({ amountPaise: 2000, reason: 'Item was cold and not as described' })
      .expect(201);
    const requestId = submitRes.body.refundRequest.id as string;

    const mgr = await managerAgent(m.outlet.id);
    // Manager can decide...
    await mgr
      .post(`/api/v1/admin/refund-requests/${requestId}/decide`)
      .set(H)
      .send({ decision: 'APPROVED' })
      .expect(200);
    // ...but cannot process
    const res = await mgr
      .post(`/api/v1/admin/refund-requests/${requestId}/process`)
      .set(H)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ─── Admin list ───────────────────────────────────────────────────────────────

describe('listing refund requests', () => {
  it('admin can list all pending requests', async () => {
    const s = await student();
    const m = await menu();
    await fund(s, 50000);

    // Create two orders, one refund request each
    for (const itemId of [m.chai.id, m.puff.id]) {
      await addToCart(s, itemId, 1);
    }
    // Two separate orders
    await addToCart(s, m.chai.id, 1);
    const orderRes1 = await placeOrder(s, 'WALLET', 2000).expect(201);
    await post(s, `/orders/${orderRes1.body.order.id}/refund-request`, {
      amountPaise: 2000,
      reason: 'Item was cold and not as described',
    }).expect(201);

    const admin = await adminAgent();
    const res = await admin
      .get('/api/v1/admin/refund-requests?status=PENDING')
      .set(H)
      .expect(200);
    expect(res.body.requests.length).toBeGreaterThanOrEqual(1);
    expect((res.body.requests as Array<{ status: string }>).every((r) => r.status === 'PENDING')).toBe(true);
  });
});
