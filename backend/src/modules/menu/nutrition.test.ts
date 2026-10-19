import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  menu,
  placeOrder,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { staffApp, staffFor, transition } from '../../tests/staff.js';

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let n = 0;

const anon = () => request(staffApp);

/** GET /api/v1/menu-items/:id/nutrition */
const getNutrition = (itemId: string) =>
  anon().get(`/api/v1/menu-items/${itemId}/nutrition`).set('X-Requested-With', 'CampusCart');

/** GET /api/v1/outlets/:slug/menu */
const outletMenu = (query = '') =>
  anon()
    .get(`/api/v1/outlets/${m.outlet.slug}/menu${query}`)
    .set('X-Requested-With', 'CampusCart');

/** GET /api/v1/menu */
const campusMenu = (query = '') =>
  anon().get(`/api/v1/menu${query}`).set('X-Requested-With', 'CampusCart');

/** PATCH /api/v1/staff/outlets/:outletId/items/:itemId — update item as manager. */
const patchItem = (agent: Agent, outletId: string, itemId: string, body: object) =>
  agent
    .patch(`/api/v1/staff/outlets/${outletId}/items/${itemId}`)
    .set('X-Requested-With', 'CampusCart')
    .send(body);

/** POST /api/v1/staff/outlets/:outletId/items — create item as manager. */
const createItem = (agent: Agent, outletId: string, body: object) =>
  agent
    .post(`/api/v1/staff/outlets/${outletId}/items`)
    .set('X-Requested-With', 'CampusCart')
    .send(body);

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu(); // Night Owl Café · Snacks: Chai ₹20, Puff ₹35
  ({ manager } = await staffFor(m.outlet.id));
});

// ─── Model and migration compatibility ───────────────────────────────────────

describe('MenuItem model — nutrition fields', () => {
  it('existing items have null nutrition and empty allergens by default', async () => {
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } });
    expect(item.calories).toBeNull();
    expect(item.protein).toBeNull();
    expect(item.carbohydrates).toBeNull();
    expect(item.fat).toBeNull();
    expect(item.allergens).toEqual([]);
  });

  it('persists full nutrition data when written directly via Prisma', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 85.5, protein: 3.2, carbohydrates: 14.0, fat: 1.8, allergens: ['DAIRY'] },
    });
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } });
    expect(item.calories).toBeCloseTo(85.5);
    expect(item.protein).toBeCloseTo(3.2);
    expect(item.carbohydrates).toBeCloseTo(14.0);
    expect(item.fat).toBeCloseTo(1.8);
    expect(item.allergens).toEqual(['DAIRY']);
  });

  it('allows partial nutrition (some fields null)', async () => {
    await prisma.menuItem.update({
      where: { id: m.puff.id },
      data: { calories: 210, allergens: ['GLUTEN', 'EGG'] },
    });
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: m.puff.id } });
    expect(item.calories).toBe(210);
    expect(item.protein).toBeNull();
    expect(item.allergens).toEqual(['GLUTEN', 'EGG']);
  });

  it('can store zero as a valid nutrition value', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 0, fat: 0, allergens: [] },
    });
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: m.chai.id } });
    expect(item.calories).toBe(0);
    expect(item.fat).toBe(0);
  });
});

// ─── Dedicated nutrition endpoint ────────────────────────────────────────────

describe('GET /api/v1/menu-items/:itemId/nutrition', () => {
  it('returns 404 for a non-existent item id', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await getNutrition(fakeId).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a non-UUID param', async () => {
    await getNutrition('not-a-uuid').expect(404);
  });

  it('returns 404 for a deactivated item', async () => {
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { isActive: false } });
    await getNutrition(m.chai.id).expect(404);
  });

  it('returns all-null nutrition when no data has been set', async () => {
    const res = await getNutrition(m.chai.id).expect(200);
    expect(res.body).toMatchObject({
      id: m.chai.id,
      name: 'Chai',
      nutrition: {
        calories: null,
        protein: null,
        carbohydrates: null,
        fat: null,
        allergens: [],
      },
    });
  });

  it('returns full nutrition when all fields are set', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: {
        calories: 120.5,
        protein: 4.0,
        carbohydrates: 18.5,
        fat: 3.1,
        allergens: ['DAIRY', 'GLUTEN'],
      },
    });
    const res = await getNutrition(m.chai.id).expect(200);
    expect(res.body).toMatchObject({
      id: m.chai.id,
      name: 'Chai',
      nutrition: {
        calories: 120.5,
        protein: 4.0,
        carbohydrates: 18.5,
        fat: 3.1,
        allergens: ['DAIRY', 'GLUTEN'],
      },
    });
  });

  it('returns partial nutrition when only some fields are set', async () => {
    await prisma.menuItem.update({
      where: { id: m.puff.id },
      data: { calories: 300, allergens: ['EGG'] },
    });
    const res = await getNutrition(m.puff.id).expect(200);
    expect(res.body.nutrition.calories).toBe(300);
    expect(res.body.nutrition.protein).toBeNull();
    expect(res.body.nutrition.allergens).toEqual(['EGG']);
  });
});

// ─── Nutrition in menu list endpoints ────────────────────────────────────────

describe('menu endpoints include nutrition in each item', () => {
  it('outlet menu returns a nutrition object on every item', async () => {
    const res = await outletMenu().expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Array<{ nutrition: unknown }>) {
      expect(item).toHaveProperty('nutrition');
      expect(item.nutrition).toMatchObject({
        calories: null,
        protein: null,
        carbohydrates: null,
        fat: null,
        allergens: [],
      });
    }
  });

  it('campus menu returns nutrition on every item', async () => {
    const res = await campusMenu().expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Array<{ nutrition: unknown }>) {
      expect(item).toHaveProperty('nutrition');
      const n = item.nutrition as Record<string, unknown>;
      expect(typeof n).toBe('object');
      expect(Array.isArray(n.allergens)).toBe(true);
    }
  });

  it('outlet menu reflects nutrition data when it has been set', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 80, allergens: ['DAIRY'] },
    });
    const res = await outletMenu().expect(200);
    const chai = (res.body.items as Array<{ name: string; nutrition: Record<string, unknown> }>).find(
      (i) => i.name === 'Chai',
    );
    expect(chai?.nutrition.calories).toBe(80);
    expect(chai?.nutrition.allergens).toEqual(['DAIRY']);
  });
});

// ─── Staff create/update with nutrition ──────────────────────────────────────

describe('staff API — nutrition validation and persistence', () => {
  it('creates an item with full nutrition data and reflects it via the nutrition endpoint', async () => {
    const res = await createItem(manager, m.outlet.id, {
      categoryId: m.category.id,
      name: 'Samosa',
      pricePaise: 1500,
      calories: 250.0,
      protein: 5.5,
      carbohydrates: 30.0,
      fat: 12.0,
      allergens: ['GLUTEN'],
    }).expect(201);

    const item = res.body.item as { id: string };
    const nRes = await getNutrition(item.id).expect(200);
    expect(nRes.body.nutrition).toMatchObject({
      calories: 250,
      protein: 5.5,
      carbohydrates: 30,
      fat: 12,
      allergens: ['GLUTEN'],
    });
  });

  it('creates an item without nutrition fields (all null / empty)', async () => {
    const res = await createItem(manager, m.outlet.id, {
      categoryId: m.category.id,
      name: 'Plain Bun',
      pricePaise: 800,
    }).expect(201);

    const item = res.body.item as { id: string };
    const nRes = await getNutrition(item.id).expect(200);
    expect(nRes.body.nutrition.calories).toBeNull();
    expect(nRes.body.nutrition.allergens).toEqual([]);
  });

  it('updates nutrition fields on an existing item', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, {
      calories: 90,
      protein: 4,
      carbohydrates: 12,
      fat: 2,
      allergens: ['DAIRY'],
    }).expect(200);

    const nRes = await getNutrition(m.chai.id).expect(200);
    expect(nRes.body.nutrition).toMatchObject({ calories: 90, allergens: ['DAIRY'] });
  });

  it('clears nutrition by patching with nulls and empty allergens', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 80, allergens: ['DAIRY'] },
    });
    await patchItem(manager, m.outlet.id, m.chai.id, {
      calories: null,
      allergens: [],
    }).expect(200);

    const nRes = await getNutrition(m.chai.id).expect(200);
    expect(nRes.body.nutrition.calories).toBeNull();
    expect(nRes.body.nutrition.allergens).toEqual([]);
  });

  it('rejects negative calorie values', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { calories: -1 }).expect(400);
  });

  it('rejects negative protein values', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { protein: -0.1 }).expect(400);
  });

  it('rejects negative carbohydrate values', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { carbohydrates: -5 }).expect(400);
  });

  it('rejects negative fat values', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { fat: -2 }).expect(400);
  });

  it('rejects an allergen array with an empty string entry', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, { allergens: ['GLUTEN', ''] }).expect(400);
  });

  it('rejects an allergen string that exceeds 50 characters', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, {
      allergens: ['A'.repeat(51)],
    }).expect(400);
  });

  it('rejects more than 20 allergens', async () => {
    await patchItem(manager, m.outlet.id, m.chai.id, {
      allergens: Array.from({ length: 21 }, (_, i) => `ALLERGEN_${i}`),
    }).expect(400);
  });

  it('rejects nutrition update from unauthenticated caller', async () => {
    await anon()
      .patch(`/api/v1/staff/outlets/${m.outlet.id}/items/${m.chai.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ calories: 100 })
      .expect(401);
  });
});

// ─── Existing cart and checkout remain unaffected ────────────────────────────

describe('existing cart and checkout are unaffected by nutrition fields', () => {
  it('can still add a nutrition-enriched item to the cart', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 80, allergens: ['DAIRY'] },
    });
    const asha = await student(`asha-nut${n}@example.com`, staffApp);
    await addToCart(asha, m.chai.id, 2).then((r) => {
      expect(r.status).toBe(200);
    });
  });

  it('can still place and complete an order containing a nutrition-enriched item', async () => {
    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 80, allergens: ['DAIRY'] },
    });
    const asha = await student(`asha-nut2-${n}@example.com`, staffApp);
    await fund(asha, 10_000);
    await addToCart(asha, m.chai.id, 1);
    const placed = await placeOrder(asha, 'WALLET', m.chai.pricePaise).expect(201);
    const orderId = placed.body.order.id as string;
    for (const to of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) {
      await transition(manager, m.outlet.id, orderId, to).expect(200);
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('COMPLETED');
  });

  it('order items snapshot does not include nutrition (prices only)', async () => {
    await prisma.menuItem.update({
      where: { id: m.puff.id },
      data: { calories: 250, allergens: ['GLUTEN', 'EGG'] },
    });
    const asha = await student(`asha-nut3-${n}@example.com`, staffApp);
    await fund(asha, 10_000);
    await addToCart(asha, m.puff.id, 1);
    const placed = await placeOrder(asha, 'WALLET', m.puff.pricePaise).expect(201);
    const items = placed.body.order.items as Array<Record<string, unknown>>;
    expect(items[0]!.name).toBe('Puff');
    expect(items[0]!.unitPricePaise).toBe(m.puff.pricePaise);
    // Nutrition is not snapshotted on the order item — it lives on the menu item only.
    expect(items[0]!.calories).toBeUndefined();
  });
});

// ─── Multiple outlets don't bleed nutrition across ───────────────────────────

describe('nutrition is scoped to each outlet correctly', () => {
  it("nutrition on one outlet's item does not affect another outlet's item", async () => {
    const other = await makeOutlet({ name: 'Fast Bites', status: 'OPEN' });
    const cat = await makeCategory(other.id, 'Snacks');
    const roll = await makeItem(other.id, cat.id, { name: 'Roll', pricePaise: 4000 });

    await prisma.menuItem.update({
      where: { id: m.chai.id },
      data: { calories: 80, allergens: ['DAIRY'] },
    });

    // Chai (Night Owl) has nutrition; Roll (Fast Bites) should not.
    const chaiRes = await getNutrition(m.chai.id).expect(200);
    const rollRes = await getNutrition(roll.id).expect(200);

    expect(chaiRes.body.nutrition.calories).toBe(80);
    expect(rollRes.body.nutrition.calories).toBeNull();
    expect(rollRes.body.nutrition.allergens).toEqual([]);
  });
});
