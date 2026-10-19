import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { prisma } from '../../lib/prisma.js';
import { ensureWallet } from '../wallet/wallet.service.js';
import { addPoints } from '../loyalty/loyalty.service.js';

// ─── App / agent helpers ───────────────────────────────────────────────────────

const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });
const H = { 'X-Requested-With': 'CampusCart' };

function makeApp() {
  return buildTestApp({ config });
}

async function signedInAgent(email: string) {
  const app = makeApp();
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

async function adminAgent() {
  // Create the user first via devLogin, then grant ADMIN role
  const app = makeApp();
  const bootstrap = request.agent(app);
  await devLogin(bootstrap, 'admin@example.com');

  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } });
  await prisma.userRole.upsert({
    where: { userId_role: { userId: user.id, role: 'ADMIN' } },
    create: { userId: user.id, role: 'ADMIN', grantedVia: 'ADMIN' },
    update: { revokedAt: null },
  });

  // Re-login so the session picks up the new role
  const freshApp = makeApp();
  const freshAgent = request.agent(freshApp);
  await devLogin(freshAgent, 'admin@example.com');
  return freshAgent;
}

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedReward(
  overrides: {
    name?: string;
    pointCost?: number;
    isActive?: boolean;
    totalStock?: number | null;
    voucherPrefix?: string | null;
    validFrom?: Date | null;
    validUntil?: Date | null;
  } = {},
) {
  return prisma.rewardCatalog.create({
    data: {
      name: overrides.name ?? 'Free Coffee',
      description: 'A hot cup of coffee',
      pointCost: overrides.pointCost ?? 100,
      isActive: overrides.isActive ?? true,
      voucherPrefix: overrides.voucherPrefix === undefined ? null : overrides.voucherPrefix,
      totalStock: overrides.totalStock === undefined ? null : overrides.totalStock,
      validFrom: overrides.validFrom === undefined ? null : overrides.validFrom,
      validUntil: overrides.validUntil === undefined ? null : overrides.validUntil,
    },
  });
}

async function givePoints(email: string, points: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const wallet = await ensureWallet(prisma, user.id);
  await prisma.$transaction(async (tx) => {
    await addPoints(tx as never, wallet.id, points);
  });
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await resetDatabase();
});

// ─── Public: browse active rewards ─────────────────────────────────────────────

describe('GET /rewards', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = makeApp();
    await request(app).get('/api/v1/rewards').set(H).expect(401);
  });

  it('lists only active rewards within the date window', async () => {
    await seedReward({ name: 'Active Reward', isActive: true });
    await seedReward({ name: 'Inactive Reward', isActive: false });
    const past = new Date(Date.now() - 86400 * 1000);
    const future = new Date(Date.now() + 86400 * 1000);
    await seedReward({ name: 'Expired', isActive: true, validUntil: past });
    await seedReward({ name: 'Not Yet', isActive: true, validFrom: future });

    const agent = await signedInAgent('u@example.com');
    const res = await agent.get('/api/v1/rewards').set(H).expect(200);
    const names = res.body.rewards.map((r: { name: string }) => r.name);
    expect(names).toContain('Active Reward');
    expect(names).not.toContain('Inactive Reward');
    expect(names).not.toContain('Expired');
    expect(names).not.toContain('Not Yet');
  });

  it('excludes out-of-stock rewards', async () => {
    await seedReward({ name: 'Sold Out', totalStock: 1 });
    // Exhaust the stock manually
    const reward = await prisma.rewardCatalog.findFirstOrThrow({ where: { name: 'Sold Out' } });
    await prisma.rewardCatalog.update({
      where: { id: reward.id },
      data: { redeemedCount: 1 },
    });

    const agent = await signedInAgent('u@example.com');
    const res = await agent.get('/api/v1/rewards').set(H).expect(200);
    const names = res.body.rewards.map((r: { name: string }) => r.name);
    expect(names).not.toContain('Sold Out');
  });
});

// ─── Student: redeem ───────────────────────────────────────────────────────────

describe('POST /rewards/:rewardId/redeem', () => {
  it('returns 403 when user is not STUDENT role', async () => {
    const reward = await seedReward({ pointCost: 50 });
    // Create MANAGER-only user: first login (gets STUDENT by default), then grant MANAGER
    const bootstrap = request.agent(makeApp());
    await devLogin(bootstrap, 'mgr@example.com');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'mgr@example.com' } });
    // Remove STUDENT role and add MANAGER
    await prisma.userRole.updateMany({
      where: { userId: user.id, role: 'STUDENT' },
      data: { revokedAt: new Date() },
    });
    await prisma.userRole.create({ data: { userId: user.id, role: 'MANAGER', grantedVia: 'ADMIN' } });
    // Re-login with updated roles
    const freshAgent = request.agent(makeApp());
    await devLogin(freshAgent, 'mgr@example.com');
    await freshAgent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(403);
  });

  it('returns 409 INSUFFICIENT_POINTS when balance is too low', async () => {
    const reward = await seedReward({ pointCost: 500 });
    await givePoints('student@example.com', 10);
    const agent = await signedInAgent('student@example.com');
    const res = await agent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('INSUFFICIENT_POINTS');
  });

  it('deducts points and creates a redemption record', async () => {
    const reward = await seedReward({ pointCost: 100 });
    await givePoints('student@example.com', 200);
    const agent = await signedInAgent('student@example.com');
    const res = await agent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(201);

    expect(res.body.redemption.rewardName).toBe('Free Coffee');
    expect(res.body.redemption.pointCost).toBe(100);
    expect(res.body.pointsBalanceAfter).toBe(100);
  });

  it('generates a voucher code when the reward has a voucherPrefix', async () => {
    const reward = await seedReward({ pointCost: 50, voucherPrefix: 'COFFEE' });
    await givePoints('student@example.com', 200);
    const agent = await signedInAgent('student@example.com');
    const res = await agent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(201);

    expect(res.body.redemption.voucherCode).toMatch(/^COFFEE-[0-9A-Z]{8}$/);
  });

  it('increments redeemedCount on the reward', async () => {
    const reward = await seedReward({ pointCost: 50 });
    await givePoints('student@example.com', 200);
    const agent = await signedInAgent('student@example.com');
    await agent.post(`/api/v1/rewards/${reward.id}/redeem`).set(H).send({}).expect(201);

    const updated = await prisma.rewardCatalog.findUniqueOrThrow({ where: { id: reward.id } });
    expect(updated.redeemedCount).toBe(1);
  });

  it('returns 409 REWARD_OUT_OF_STOCK when stock is exhausted', async () => {
    const reward = await seedReward({ pointCost: 50, totalStock: 1 });
    await prisma.rewardCatalog.update({
      where: { id: reward.id },
      data: { redeemedCount: 1 },
    });
    await givePoints('student@example.com', 500);
    const agent = await signedInAgent('student@example.com');
    const res = await agent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('REWARD_OUT_OF_STOCK');
  });

  it('returns 404 for an unknown rewardId', async () => {
    await givePoints('student@example.com', 500);
    const agent = await signedInAgent('student@example.com');
    await agent
      .post('/api/v1/rewards/00000000-0000-0000-0000-000000000000/redeem')
      .set(H)
      .send({})
      .expect(404);
  });

  it('returns 409 REWARD_EXPIRED when the reward is past validUntil', async () => {
    const past = new Date(Date.now() - 86400 * 1000);
    const reward = await seedReward({ pointCost: 50, validUntil: past });
    await givePoints('student@example.com', 500);
    const agent = await signedInAgent('student@example.com');
    const res = await agent
      .post(`/api/v1/rewards/${reward.id}/redeem`)
      .set(H)
      .send({})
      .expect(409);
    expect(res.body.code).toBe('REWARD_EXPIRED');
  });
});

// ─── Student: redemption history ──────────────────────────────────────────────

describe('GET /me/rewards', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = makeApp();
    await request(app).get('/api/v1/me/rewards').set(H).expect(401);
  });

  it("returns only the calling user's own redemptions", async () => {
    const reward = await seedReward({ pointCost: 50 });
    await givePoints('alice@example.com', 500);
    await givePoints('bob@example.com', 500);

    const alice = await signedInAgent('alice@example.com');
    const bob = await signedInAgent('bob@example.com');

    await alice.post(`/api/v1/rewards/${reward.id}/redeem`).set(H).send({}).expect(201);
    await bob.post(`/api/v1/rewards/${reward.id}/redeem`).set(H).send({}).expect(201);

    const res = await alice.get('/api/v1/me/rewards').set(H).expect(200);
    expect(res.body.redemptions).toHaveLength(1);
    expect(res.body.redemptions[0].rewardName).toBe('Free Coffee');
  });
});

// ─── Admin: catalog management ────────────────────────────────────────────────

describe('admin rewards', () => {
  it('GET /admin/rewards returns 403 for non-admin', async () => {
    const agent = await signedInAgent('u@example.com');
    await agent.get('/api/v1/admin/rewards').set(H).expect(403);
  });

  it('GET /admin/rewards lists all rewards including inactive', async () => {
    await seedReward({ name: 'Active', isActive: true });
    await seedReward({ name: 'Inactive', isActive: false });
    const admin = await adminAgent();
    const res = await admin.get('/api/v1/admin/rewards').set(H).expect(200);
    const names = res.body.rewards.map((r: { name: string }) => r.name);
    expect(names).toContain('Active');
    expect(names).toContain('Inactive');
  });

  it('POST /admin/rewards creates a new reward', async () => {
    const admin = await adminAgent();
    const res = await admin
      .post('/api/v1/admin/rewards')
      .set(H)
      .send({ name: 'New Reward', pointCost: 200 })
      .expect(201);
    expect(res.body.reward.name).toBe('New Reward');
    expect(res.body.reward.pointCost).toBe(200);
    expect(res.body.reward.isActive).toBe(true);
  });

  it('POST /admin/rewards rejects invalid input (missing pointCost)', async () => {
    const admin = await adminAgent();
    await admin
      .post('/api/v1/admin/rewards')
      .set(H)
      .send({ name: 'Bad Reward' })
      .expect(400);
  });

  it('PATCH /admin/rewards/:rewardId updates a reward', async () => {
    const reward = await seedReward({ name: 'Old Name' });
    const admin = await adminAgent();
    const res = await admin
      .patch(`/api/v1/admin/rewards/${reward.id}`)
      .set(H)
      .send({ name: 'New Name', isActive: false })
      .expect(200);
    expect(res.body.reward.name).toBe('New Name');
    expect(res.body.reward.isActive).toBe(false);
  });

  it('PATCH /admin/rewards/:rewardId returns 409 when setting stock below redeemed count', async () => {
    const reward = await seedReward({ totalStock: 10 });
    await prisma.rewardCatalog.update({ where: { id: reward.id }, data: { redeemedCount: 5 } });
    const admin = await adminAgent();
    const res = await admin
      .patch(`/api/v1/admin/rewards/${reward.id}`)
      .set(H)
      .send({ totalStock: 3 })
      .expect(409);
    expect(res.body.code).toBe('STOCK_BELOW_REDEEMED');
  });

  it('GET /admin/rewards/:rewardId/redemptions lists all redemptions for that reward', async () => {
    const reward = await seedReward({ pointCost: 50 });
    await givePoints('alice@example.com', 500);
    await givePoints('bob@example.com', 500);

    const alice = await signedInAgent('alice@example.com');
    const bob = await signedInAgent('bob@example.com');
    await alice.post(`/api/v1/rewards/${reward.id}/redeem`).set(H).send({}).expect(201);
    await bob.post(`/api/v1/rewards/${reward.id}/redeem`).set(H).send({}).expect(201);

    const admin = await adminAgent();
    const res = await admin
      .get(`/api/v1/admin/rewards/${reward.id}/redemptions`)
      .set(H)
      .expect(200);
    expect(res.body.redemptions).toHaveLength(2);
    const emails = res.body.redemptions.map((r: { user: { email: string } }) => r.user.email);
    expect(emails).toContain('alice@example.com');
    expect(emails).toContain('bob@example.com');
  });
});
