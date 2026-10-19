import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma, resetDatabase } from '../../tests/db.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';
import { addToCart, app, menu, post, student, type Agent } from '../../tests/commerce.js';

let s: Agent;
let m: Awaited<ReturnType<typeof menu>>;

beforeEach(async () => {
  await resetDatabase();
  m = await menu();
  s = await student();
});

describe('cart', () => {
  it('requires sign-in', async () => {
    await request(app).get('/api/v1/cart').expect(401);
  });

  it('starts empty, then holds items with prices read live from the menu', async () => {
    expect((await s.get('/api/v1/cart').expect(200)).body.cart).toMatchObject({
      items: [],
      totalPaise: 0,
    });
    await addToCart(s, m.chai.id, 2);
    await addToCart(s, m.puff.id);
    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    expect(cart).toMatchObject({
      itemCount: 3,
      subtotalPaise: 7500,
      totalPaise: 7500,
      canCheckout: true,
    });
    expect(cart.outlet.name).toBe('Night Owl Café');

    // A price change is reflected immediately — the cart never stores prices.
    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { pricePaise: 2500 } });
    expect((await s.get('/api/v1/cart').expect(200)).body.cart.totalPaise).toBe(8500);
  });

  it('ignores any price the client tries to send', async () => {
    const res = await post(s, '/cart/items', { menuItemId: m.chai.id, quantity: 1, pricePaise: 1 });
    expect(res.status).toBe(400);
  });

  it('adds to the quantity of an existing line and enforces 1–10', async () => {
    await addToCart(s, m.chai.id, 6);
    const tooMany = await post(s, '/cart/items', { menuItemId: m.chai.id, quantity: 5 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('QUANTITY_LIMIT');
    await post(s, '/cart/items', { menuItemId: m.chai.id, quantity: 0 }).expect(400);
    await s
      .patch(`/api/v1/cart/items/${m.chai.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ quantity: 11 })
      .expect(400);
    const ok = await s
      .patch(`/api/v1/cart/items/${m.chai.id}`)
      .set('X-Requested-With', 'CampusCart')
      .send({ quantity: 10 })
      .expect(200);
    expect(ok.body.cart.items[0].quantity).toBe(10);
  });

  it('refuses sold-out items, closed outlets and items not on the menu', async () => {
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    expect((await post(s, '/cart/items', { menuItemId: m.puff.id })).body.error.code).toBe(
      'ITEM_UNAVAILABLE',
    );

    const closed = await makeOutlet({ status: 'CLOSED' });
    const closedItem = await makeItem(closed.id, (await makeCategory(closed.id)).id);
    expect((await post(s, '/cart/items', { menuItemId: closedItem.id })).body.error.code).toBe(
      'OUTLET_NOT_ACCEPTING',
    );

    await prisma.menuItem.update({ where: { id: m.chai.id }, data: { isActive: false } });
    await post(s, '/cart/items', { menuItemId: m.chai.id }).expect(404);
  });

  it('allows items from multiple outlets in one cart', async () => {
    await addToCart(s, m.chai.id);
    const other = await makeOutlet({ name: 'Tandoor Corner', status: 'OPEN' });
    const roll = await makeItem(other.id, (await makeCategory(other.id)).id, {
      name: 'Roll',
      pricePaise: 4500,
    });

    const res = await post(s, '/cart/items', { menuItemId: roll.id }).expect(200);
    const cart = res.body.cart;
    // Multi-outlet: top-level outlet is null, outletGroups has both
    expect(cart.outlet).toBeNull();
    expect(cart.isMultiOutlet).toBe(true);
    expect(cart.outletGroups).toHaveLength(2);
    expect(cart.items).toHaveLength(2);
    expect(cart.subtotalPaise).toBe(2000 + 4500);
    expect(cart.canCheckout).toBe(true);
  });

  it('replaceCart clears existing items before adding', async () => {
    await addToCart(s, m.chai.id);
    const other = await makeOutlet({ name: 'Tandoor Corner', status: 'OPEN' });
    const roll = await makeItem(other.id, (await makeCategory(other.id)).id, { name: 'Roll' });
    const res = await post(s, '/cart/items', { menuItemId: roll.id, replaceCart: true }).expect(
      200,
    );
    expect(res.body.cart.outlet!.name).toBe('Tandoor Corner');
    expect(res.body.cart.items.map((i: { name: string }) => i.name)).toEqual(['Roll']);
  });

  it('flags items that became unavailable and blocks checkout until they are removed', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, m.puff.id);
    await prisma.menuItem.update({ where: { id: m.puff.id }, data: { isAvailable: false } });
    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    expect(cart.canCheckout).toBe(false);
    expect(cart.issues).toEqual([{ menuItemId: m.puff.id, name: 'Puff', reason: 'SOLD_OUT' }]);

    const after = await s
      .delete(`/api/v1/cart/items/${m.puff.id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(200);
    expect(after.body.cart.canCheckout).toBe(true);
  });

  it('clears the cart', async () => {
    await addToCart(s, m.chai.id);
    const res = await s.delete('/api/v1/cart').set('X-Requested-With', 'CampusCart').expect(200);
    expect(res.body.cart).toMatchObject({ items: [], outlet: null });
  });

  it('keeps each student’s cart private', async () => {
    await addToCart(s, m.chai.id);
    const other = await student('other@example.com');
    expect((await other.get('/api/v1/cart').expect(200)).body.cart.items).toEqual([]);
    await other
      .delete(`/api/v1/cart/items/${m.chai.id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(404);
    expect((await s.get('/api/v1/cart').expect(200)).body.cart.items).toHaveLength(1);
  });
});
