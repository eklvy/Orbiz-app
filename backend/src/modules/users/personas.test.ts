/**
 * Tests for the new persona roles: FACULTY, STAFF, EXECUTIVE, GUEST.
 * Verifies role grant/revoke, ordering permissions, and privilege separation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase, prisma } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { makeOutlet, makeCategory, makeItem } from '../../tests/fixtures.js';
import { post, fund, key } from '../../tests/commerce.js';

const H = { 'X-Requested-With': 'CampusCart' };
const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });

function makeApp() {
  return buildTestApp({ config });
}

async function createUser(email: string) {
  const app = makeApp();
  const agent = request.agent(app);
  await devLogin(agent, email);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { agent, user };
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

async function grantPersona(
  adminAgentInstance: ReturnType<typeof request.agent>,
  userId: string,
  role: string,
) {
  return adminAgentInstance
    .post(`/api/v1/admin/users/${userId}/roles`)
    .set(H)
    .send({ role })
    .expect(201);
}

beforeEach(async () => {
  await resetDatabase();
});

// ─── Role granting ────────────────────────────────────────────────────────────

describe('admin can grant persona roles', () => {
  it.each(['FACULTY', 'STAFF', 'EXECUTIVE', 'GUEST'] as const)(
    'grants %s role without allowlist restriction',
    async (persona) => {
      const { user } = await createUser('target@example.com');
      const admin = await adminAgent();
      const res = await admin
        .post(`/api/v1/admin/users/${user.id}/roles`)
        .set(H)
        .send({ role: persona })
        .expect(201);
      expect(res.body.changed).toBe(true);

      // Verify the role appears in the user list
      const listRes = await admin
        .get(`/api/v1/admin/users?q=target@example.com`)
        .set(H)
        .expect(200);
      const roles = listRes.body.users[0].roles as string[];
      expect(roles).toContain(persona);
    },
  );

  it('non-admin cannot grant persona roles', async () => {
    const { user: target } = await createUser('target@example.com');
    const { agent: actor } = await createUser('actor@example.com');
    await actor
      .post(`/api/v1/admin/users/${target.id}/roles`)
      .set(H)
      .send({ role: 'FACULTY' })
      .expect(403);
  });

  it('rejects unknown role values', async () => {
    const { user } = await createUser('target@example.com');
    const admin = await adminAgent();
    await admin
      .post(`/api/v1/admin/users/${user.id}/roles`)
      .set(H)
      .send({ role: 'SUPERUSER' })
      .expect(400);
  });
});

// ─── Ordering permissions ─────────────────────────────────────────────────────

describe('persona ordering permissions', () => {
  async function setupMenu() {
    const outlet = await makeOutlet({ name: 'Test Café', status: 'OPEN' });
    const cat = await makeCategory(outlet.id, 'Food');
    const item = await makeItem(outlet.id, cat.id, { name: 'Chai', pricePaise: 2000 });
    return { outlet, item };
  }

  async function canPlaceOrder(agent: ReturnType<typeof request.agent>, itemId: string) {
    // Fund the wallet first
    await fund(agent, 50000);
    await post(agent, '/cart/items', { menuItemId: itemId, quantity: 1 }).expect(200);
    const res = await agent
      .post('/api/v1/orders')
      .set(H)
      .set('Idempotency-Key', key())
      .send({ paymentMethod: 'WALLET', expectedTotalPaise: 2000 });
    return res.status;
  }

  it('FACULTY can place orders', async () => {
    const { item } = await setupMenu();
    const { user } = await createUser('faculty@example.com');
    const admin = await adminAgent();

    // Remove STUDENT, add FACULTY (to test FACULTY role specifically)
    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await grantPersona(admin, user.id, 'FACULTY');

    // Re-login so session picks up new roles
    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'faculty@example.com');
    const status = await canPlaceOrder(freshAgent, item.id);
    expect(status).toBe(201);
  });

  it('STAFF can place orders', async () => {
    const { item } = await setupMenu();
    const { user } = await createUser('staff@example.com');
    const admin = await adminAgent();

    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await grantPersona(admin, user.id, 'STAFF');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'staff@example.com');
    const status = await canPlaceOrder(freshAgent, item.id);
    expect(status).toBe(201);
  });

  it('EXECUTIVE can place orders', async () => {
    const { item } = await setupMenu();
    const { user } = await createUser('exec@example.com');
    const admin = await adminAgent();

    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await grantPersona(admin, user.id, 'EXECUTIVE');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'exec@example.com');
    const status = await canPlaceOrder(freshAgent, item.id);
    expect(status).toBe(201);
  });

  it('GUEST cannot place orders', async () => {
    const { item } = await setupMenu();
    const { user } = await createUser('guest@example.com');
    const admin = await adminAgent();

    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await grantPersona(admin, user.id, 'GUEST');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'guest@example.com');
    // GUEST cannot order — should get 403
    await post(freshAgent, '/cart/items', { menuItemId: item.id, quantity: 1 }).expect(200);
    // Actually the cart add doesn't require role, only checkout does
    const res = await freshAgent
      .post('/api/v1/orders')
      .set(H)
      .set('Idempotency-Key', key())
      .send({ paymentMethod: 'WALLET', expectedTotalPaise: 2000 });
    expect(res.status).toBe(403);
  });

  it('FACULTY can cancel their own order', async () => {
    const { item } = await setupMenu();
    const { user } = await createUser('faculty@example.com');
    const admin = await adminAgent();

    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await grantPersona(admin, user.id, 'FACULTY');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'faculty@example.com');
    await fund(freshAgent, 50000);
    await post(freshAgent, '/cart/items', { menuItemId: item.id, quantity: 1 }).expect(200);
    const orderRes = await freshAgent
      .post('/api/v1/orders')
      .set(H)
      .set('Idempotency-Key', key())
      .send({ paymentMethod: 'WALLET', expectedTotalPaise: 2000 })
      .expect(201);

    const orderId = orderRes.body.order.id;
    await post(freshAgent, `/orders/${orderId}/cancel`, {}).expect(200);
  });
});

// ─── Persona does not grant outlet management ─────────────────────────────────

describe('personas do not grant outlet management', () => {
  it('FACULTY cannot update outlet settings', async () => {
    const outlet = await makeOutlet({ name: 'Café', status: 'OPEN' });
    const { user } = await createUser('faculty@example.com');
    const admin = await adminAgent();
    await grantPersona(admin, user.id, 'FACULTY');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'faculty@example.com');
    // Outlet update requires MANAGER or ADMIN
    await freshAgent
      .patch(`/api/v1/admin/outlets/${outlet.id}`)
      .set(H)
      .send({ name: 'Hacked' })
      .expect(403);
  });

  it('EXECUTIVE cannot access admin audit logs', async () => {
    const { user } = await createUser('exec@example.com');
    const admin = await adminAgent();
    await grantPersona(admin, user.id, 'EXECUTIVE');

    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'exec@example.com');
    await freshAgent.get('/api/v1/admin/audit-logs').set(H).expect(403);
  });
});

// ─── Role revocation ──────────────────────────────────────────────────────────

describe('persona role revocation', () => {
  it('admin can revoke a persona role', async () => {
    const { user } = await createUser('target@example.com');
    const admin = await adminAgent();
    await grantPersona(admin, user.id, 'FACULTY');

    await admin
      .post(`/api/v1/admin/users/${user.id}/roles/FACULTY/revoke`)
      .set(H)
      .send({ reason: 'No longer faculty' })
      .expect(200);

    const listRes = await admin.get(`/api/v1/admin/users?q=target@example.com`).set(H).expect(200);
    const roles = listRes.body.users[0].roles as string[];
    expect(roles).not.toContain('FACULTY');
  });
});
