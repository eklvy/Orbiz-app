import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resetDatabase } from '../../tests/db.js';
import { buildTestApp, devLogin, testConfig } from '../../tests/helpers.js';
import { makeOutlet, makeCategory, makeItem } from '../../tests/fixtures.js';
import { prisma } from '../../lib/prisma.js';
import type { ChatProvider, ChatMessage } from './bitebot.provider.js';

// ─── Fake provider ────────────────────────────────────────────────────────────

type FakeCall = { messages: ChatMessage[]; systemPrompt: string };

function fakeChatProvider(reply = 'Hello from BiteBot!'): ChatProvider & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    name: 'fake',
    calls,
    async complete(messages, systemPrompt, _signal) {
      calls.push({ messages, systemPrompt });
      return reply;
    },
  };
}

function failingProvider(message = 'provider_unavailable'): ChatProvider {
  return {
    name: 'failing',
    async complete() {
      throw new Error(message);
    },
  };
}

// ─── App builders ─────────────────────────────────────────────────────────────

const config = testConfig({ PAYMENT_MOCK_ENABLED: 'true' });

function appWith(chatProvider: ChatProvider | null) {
  return buildTestApp({ config, chatProvider });
}

const H = { 'X-Requested-With': 'CampusCart' };

async function signedInAgent(app: ReturnType<typeof appWith>, email: string) {
  const agent = request.agent(app);
  await devLogin(agent, email);
  return agent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await resetDatabase();
});

describe('authentication', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = appWith(null);
    await request(app)
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'hi' })
      .expect(401);
  });

  it('allows any signed-in user (student, manager, etc.)', async () => {
    const agent = await signedInAgent(appWith(null), 'anyone@example.com');
    const res = await agent.post('/api/v1/chat/bitebot').set(H).send({ message: 'hi' }).expect(200);
    expect(res.body.reply).toBeTruthy();
  });
});

describe('input validation', () => {
  it('rejects empty message', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    await agent.post('/api/v1/chat/bitebot').set(H).send({ message: '' }).expect(400);
  });

  it('rejects missing message', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    await agent.post('/api/v1/chat/bitebot').set(H).send({}).expect(400);
  });

  it('rejects a message longer than 1000 characters', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'x'.repeat(1001) })
      .expect(400);
  });

  it('rejects unknown extra fields (strict schema)', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'hi', extraField: 'x' })
      .expect(400);
  });

  it('rejects history array longer than 10 entries', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    const history = Array.from({ length: 11 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'msg',
    }));
    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'hi', history })
      .expect(400);
  });
});

describe('provider unavailable (no key configured)', () => {
  it('returns a fallback reply with aiUsed: false', async () => {
    const agent = await signedInAgent(appWith(null), 'u@example.com');
    const res = await agent.post('/api/v1/chat/bitebot').set(H).send({ message: 'hi' }).expect(200);
    expect(res.body.aiUsed).toBe(false);
    expect(res.body.reply).toBeTruthy();
  });
});

describe('provider error / timeout', () => {
  it('returns a fallback reply when the provider throws', async () => {
    const agent = await signedInAgent(appWith(failingProvider()), 'u@example.com');
    const res = await agent.post('/api/v1/chat/bitebot').set(H).send({ message: 'hi' }).expect(200);
    expect(res.body.aiUsed).toBe(false);
    expect(res.body.reply).toBeTruthy();
  });
});

describe('successful chat with grounded data', () => {
  it('returns the provider reply with aiUsed: true', async () => {
    const provider = fakeChatProvider('You can order Chai at ₹20!');
    const agent = await signedInAgent(appWith(provider), 'u@example.com');

    const res = await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'What can I eat?' })
      .expect(200);

    expect(res.body.aiUsed).toBe(true);
    expect(res.body.reply).toBe('You can order Chai at ₹20!');
  });

  it('includes outlet data in the system prompt', async () => {
    await makeOutlet({ name: 'Sunrise Café', status: 'OPEN' });
    const provider = fakeChatProvider('Outlet info included.');
    const agent = await signedInAgent(appWith(provider), 'u@example.com');

    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'Tell me about outlets' })
      .expect(200);

    const { systemPrompt } = provider.calls[0]!;
    expect(systemPrompt).toContain('Sunrise Café');
    expect(systemPrompt).toContain('OPEN');
  });

  it('includes full menu when the user names an outlet', async () => {
    const outlet = await makeOutlet({ name: 'Night Owl', status: 'OPEN' });
    const category = await makeCategory(outlet.id, 'Drinks');
    await makeItem(outlet.id, category.id, {
      name: 'Masala Chai',
      pricePaise: 2000,
      dietary: 'VEG',
    });

    const provider = fakeChatProvider('Masala Chai is great!');
    const agent = await signedInAgent(appWith(provider), 'u@example.com');

    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'What does Night Owl serve?' })
      .expect(200);

    const { systemPrompt } = provider.calls[0]!;
    expect(systemPrompt).toContain('Masala Chai');
    expect(systemPrompt).toContain('₹20');
    expect(systemPrompt).toContain('[VEG]');
  });

  it('includes the groundedOn list in the response', async () => {
    const outlet = await makeOutlet({ name: 'Sunrise Café', status: 'OPEN' });
    const category = await makeCategory(outlet.id, 'Food');
    await makeItem(outlet.id, category.id, { name: 'Sandwich', pricePaise: 5000 });

    const provider = fakeChatProvider('reply');
    const agent = await signedInAgent(appWith(provider), 'u@example.com');

    const res = await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'Menu at Sunrise Café?' })
      .expect(200);

    expect(res.body.groundedOn).toContain('outlets');
    expect(res.body.groundedOn).toContain('Sunrise Café menu');
  });
});

describe('ownership: personal order data', () => {
  it("includes only the requesting user's own orders in the prompt", async () => {
    // Create two users, one order each
    const aliceApp = appWith(fakeChatProvider('ok'));
    await signedInAgent(aliceApp, 'alice@example.com');
    await signedInAgent(aliceApp, 'bob@example.com');

    const outlet = await makeOutlet({ name: 'Test Café', status: 'OPEN' });
    const category = await makeCategory(outlet.id, 'Food');
    const item = await makeItem(outlet.id, category.id, { name: 'Dosa', pricePaise: 4000 });

    // Insert a raw order for Alice
    const aliceUser = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
    const bobUser = await prisma.user.findUniqueOrThrow({ where: { email: 'bob@example.com' } });

    await prisma.order.create({
      data: {
        userId: aliceUser.id,
        outletId: outlet.id,
        pickupDay: new Date(),
        pickupNumber: 1,
        pickupCode: 'A-001',
        status: 'COMPLETED',
        paymentMethod: 'COUNTER',
        paymentStatus: 'VOID',
        subtotalPaise: 4000,
        totalPaise: 4000,
        idempotencyKey: 'alice-order-1',
        items: { create: { menuItemId: item.id, name: 'Dosa', quantity: 1, unitPricePaise: 4000, lineTotalPaise: 4000 } },
      },
    });

    await prisma.order.create({
      data: {
        userId: bobUser.id,
        outletId: outlet.id,
        pickupDay: new Date(),
        pickupNumber: 2,
        pickupCode: 'B-002',
        status: 'PLACED',
        paymentMethod: 'COUNTER',
        paymentStatus: 'PENDING_COUNTER',
        subtotalPaise: 4000,
        totalPaise: 4000,
        idempotencyKey: 'bob-order-1',
        items: { create: { menuItemId: item.id, name: 'Dosa', quantity: 1, unitPricePaise: 4000, lineTotalPaise: 4000 } },
      },
    });

    // (aliceApp's built-in provider is discarded; we use a fresh provider below)
    // We need to extract the provider from the closure — let's use a new provider
    const provider = fakeChatProvider('ok');
    const appForAlice = buildTestApp({ config, chatProvider: provider });
    const aliceAgent = await signedInAgent(appForAlice, 'alice@example.com');

    await aliceAgent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'What are my orders?' })
      .expect(200);

    const { systemPrompt } = provider.calls[0]!;
    // Alice's order appears
    expect(systemPrompt).toContain('A-001');
    // Bob's order must NOT appear
    expect(systemPrompt).not.toContain('B-002');
  });
});

describe('conversation history', () => {
  it('forwards history turns to the provider', async () => {
    const provider = fakeChatProvider('reply');
    const agent = await signedInAgent(appWith(provider), 'u@example.com');

    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    await agent
      .post('/api/v1/chat/bitebot')
      .set(H)
      .send({ message: 'Follow-up question', history })
      .expect(200);

    const { messages } = provider.calls[0]!;
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hi there!' });
    expect(messages[2]).toMatchObject({ role: 'user', content: 'Follow-up question' });
  });
});
