import type { Database } from '../../lib/prisma.js';
import type { ChatMessage, ChatProvider } from './bitebot.provider.js';

/*
 * BiteBot chat service.
 *
 * Grounding strategy:
 *   1. Always include a brief list of active outlets (name, status, location).
 *   2. If the user's message names an outlet, include its full live menu
 *      (prices, dietary flags, allergens, nutrition, availability) so the
 *      model never has to guess or invent figures.
 *   3. Include the requesting user's 3 most recent orders — scoped strictly to
 *      that user — so the model can answer order-status questions without
 *      guessing.
 *
 * Rules enforced here (not just in the system prompt):
 *   - Context data always comes from the DB; the model's text is not trusted
 *     for prices, availability, or order status.
 *   - Private order data is only ever fetched for the authenticated userId
 *     supplied by the route; no ownership bypass is possible here.
 *   - Replies are capped at MAX_TOKENS by the provider and then sanitised
 *     (control characters stripped) before being returned to the caller.
 */

export const BITEBOT_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `\
You are BiteBot, the friendly AI assistant for the Orbiz campus canteen app.

You help students with:
- Finding menu items, prices, dietary information, and allergens
- Checking outlet status and locations
- Answering questions about their own recent orders
- General canteen and ordering FAQs

RULES (never break these):
1. Only state prices, availability, ingredients, or order details that appear in the CONTEXT section below.
2. If the information is not in the CONTEXT, say you don't have that information right now rather than guessing.
3. Do not invent promotions, discounts, or offers not shown in the CONTEXT.
4. Keep replies concise — ideally one to three short paragraphs.
5. Be friendly and helpful. If you cannot answer, suggest the student visit the outlet or speak to staff.

CONTEXT:
{CONTEXT}`;

// ─── Context assembly ─────────────────────────────────────────────────────────

async function buildContext(
  db: Database,
  userId: string,
  message: string,
): Promise<{ text: string; sources: string[] }> {
  const parts: string[] = [];
  const sources: string[] = [];

  // 1. Active outlets
  const outlets = await db.outlet.findMany({
    where: { isActive: true },
    select: { id: true, name: true, status: true, location: true },
    orderBy: { name: 'asc' },
  });

  parts.push('=== Outlets ===');
  for (const o of outlets) {
    parts.push(`- ${o.name}: ${o.status}${o.location ? ` — ${o.location}` : ''}`);
  }
  if (outlets.length > 0) sources.push('outlets');

  // 2. Full menu for any outlet the user mentioned by name
  const lowerMsg = message.toLowerCase();
  const mentioned = outlets.filter((o) => lowerMsg.includes(o.name.toLowerCase()));

  for (const outlet of mentioned) {
    const items = await db.menuItem.findMany({
      where: { outletId: outlet.id, isActive: true, category: { isActive: true } },
      include: { category: { select: { name: true } } },
      orderBy: [{ category: { name: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    });

    if (items.length === 0) continue;

    parts.push(`\n=== ${outlet.name} Menu ===`);
    let lastCat = '';
    for (const item of items) {
      if (item.category.name !== lastCat) {
        lastCat = item.category.name;
        parts.push(`[${lastCat}]`);
      }
      const price = `₹${(item.pricePaise / 100).toFixed(0)}`;
      const dietary = item.dietary ? ` [${item.dietary}]` : '';
      const avail = item.isAvailable ? '' : ' (sold out)';
      const allergens =
        item.allergens.length > 0 ? ` | Allergens: ${item.allergens.join(', ')}` : '';
      const kcal = item.calories != null ? ` | ${item.calories} kcal` : '';
      parts.push(`  ${item.name}${dietary}: ${price}${avail}${allergens}${kcal}`);
    }
    sources.push(`${outlet.name} menu`);
  }

  // 3. User's 3 most recent orders (ownership strictly enforced by the userId parameter)
  const recentOrders = await db.order.findMany({
    where: { userId },
    select: {
      pickupCode: true,
      status: true,
      totalPaise: true,
      placedAt: true,
      outlet: { select: { name: true } },
      items: { select: { name: true, quantity: true } },
    },
    orderBy: { placedAt: 'desc' },
    take: 3,
  });

  if (recentOrders.length > 0) {
    parts.push('\n=== Your Recent Orders ===');
    for (const order of recentOrders) {
      const itemList = order.items.map((i) => `${i.name}×${i.quantity}`).join(', ');
      const total = `₹${(order.totalPaise / 100).toFixed(0)}`;
      const date = order.placedAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      parts.push(
        `- [${order.pickupCode}] ${date} at ${order.outlet.name}: ${itemList} (${total}) — ${order.status}`,
      );
    }
    sources.push('your orders');
  }

  return { text: parts.join('\n'), sources };
}

// ─── Strip control characters from model output ────────────────────────────────

function sanitiseReply(text: string): string {
  return text
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      // Allow printable ASCII and common Unicode; strip control chars (except newlines / tabs)
      if (code < 32 && code !== 10 && code !== 9) return ' ';
      if (code === 127) return ' ';
      return ch;
    })
    .join('')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ChatInput {
  userId: string;
  message: string;
  /** Previous turns to preserve context. Capped at 10 pairs by the route. */
  history?: ChatMessage[];
}

export interface ChatResult {
  reply: string;
  /** Which data sources were used to ground the answer. */
  groundedOn: string[];
  /** True when an AI provider is configured and responded. */
  aiUsed: boolean;
}

const UNAVAILABLE_REPLY =
  "I'm not available right now. Please speak to canteen staff or check the menu directly in the app.";

/**
 * Main entry point. Returns a grounded reply, or a fallback if the provider
 * is unavailable / not configured.
 */
export async function chat(
  db: Database,
  provider: ChatProvider | null,
  input: ChatInput,
): Promise<ChatResult> {
  const { text: contextText, sources } = await buildContext(db, input.userId, input.message);

  if (!provider) {
    return { reply: UNAVAILABLE_REPLY, groundedOn: sources, aiUsed: false };
  }

  const systemPrompt = SYSTEM_PROMPT.replace('{CONTEXT}', contextText);

  const messages: ChatMessage[] = [
    ...(input.history ?? []),
    { role: 'user', content: input.message },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BITEBOT_TIMEOUT_MS);

  let raw: string;
  try {
    raw = await provider.complete(messages, systemPrompt, controller.signal);
  } catch {
    return { reply: UNAVAILABLE_REPLY, groundedOn: sources, aiUsed: false };
  } finally {
    clearTimeout(timer);
  }

  return { reply: sanitiseReply(raw), groundedOn: sources, aiUsed: true };
}
