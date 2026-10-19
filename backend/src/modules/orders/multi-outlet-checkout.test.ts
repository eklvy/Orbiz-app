/**
 * Tests for multi-outlet cart and checkout:
 * - Adding items from multiple outlets to one cart
 * - Single checkout that creates one order per outlet
 * - Idempotency (same batchKey → same orders returned)
 * - Price changes, unavailable items, insufficient balance
 * - Points distributed pro-rata
 * - Backward compat: res.body.order still works for single-outlet
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  key,
  menu,
  placeOrder,
  post,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { makeCategory, makeItem, makeOutlet } from '../../tests/fixtures.js';

let s: Agent;
let m: Awaited<ReturnType<typeof menu>>;

// Second outlet fixtures
let outlet2: Awaited<ReturnType<typeof makeOutlet>>;
let item2: Awaited<ReturnType<typeof makeItem>>;

beforeEach(async () => {
  await resetDatabase();
  m = await menu(); // Night Owl Café: chai ₹20, puff ₹35
  s = await student();
  outlet2 = await makeOutlet({ name: 'Tandoor Corner', status: 'OPEN' });
  const cat2 = await makeCategory(outlet2.id, 'Mains');
  item2 = await makeItem(outlet2.id, cat2.id, { name: 'Roll', pricePaise: 4500 });
});

// ─── Cart view ────────────────────────────────────────────────────────────────

describe('multi-outlet cart view', () => {
  it('outlet is null and isMultiOutlet true when items span outlets', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);

    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    expect(cart.outlet).toBeNull();
    expect(cart.isMultiOutlet).toBe(true);
    expect(cart.outletGroups).toHaveLength(2);
    expect(cart.subtotalPaise).toBe(2000 + 4500);
    expect(cart.canCheckout).toBe(true);
  });

  it('outletGroups has per-outlet subtotals and item lists', async () => {
    await addToCart(s, m.chai.id, 2); // 2 × ₹20 = ₹40
    await addToCart(s, item2.id); // 1 × ₹45 = ₹45

    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    const groups = cart.outletGroups as Array<{
      outlet: { name: string };
      items: { name: string }[];
      subtotalPaise: number;
    }>;
    const nightOwl = groups.find((g) => g.outlet.name === 'Night Owl Café');
    const tandoor = groups.find((g) => g.outlet.name === 'Tandoor Corner');
    expect(nightOwl).toBeDefined();
    expect(tandoor).toBeDefined();
    expect(nightOwl!.subtotalPaise).toBe(4000);
    expect(tandoor!.subtotalPaise).toBe(4500);
    expect(nightOwl!.items.map((i) => i.name)).toEqual(['Chai']);
    expect(tandoor!.items.map((i) => i.name)).toEqual(['Roll']);
  });

  it('outlet is populated (not null) for single-outlet carts', async () => {
    await addToCart(s, m.chai.id);
    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    expect(cart.outlet).not.toBeNull();
    expect(cart.outlet.name).toBe('Night Owl Café');
    expect(cart.isMultiOutlet).toBe(false);
  });

  it('removing the only item from one outlet collapses back to single-outlet', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    await s
      .delete(`/api/v1/cart/items/${item2.id}`)
      .set('X-Requested-With', 'CampusCart')
      .expect(200);
    const { cart } = (await s.get('/api/v1/cart').expect(200)).body;
    expect(cart.isMultiOutlet).toBe(false);
    expect(cart.outlet!.name).toBe('Night Owl Café');
  });
});

// ─── Multi-outlet checkout ────────────────────────────────────────────────────

describe('multi-outlet checkout', () => {
  it('creates one order per outlet, all linked by batchKey', async () => {
    await fund(s, 20000);
    await addToCart(s, m.chai.id); // Night Owl: ₹20
    await addToCart(s, item2.id); // Tandoor: ₹45
    const total = 2000 + 4500;

    const res = await placeOrder(s, 'WALLET', total).expect(201);

    // Backward compat: order is the first order
    expect(res.body.order).toBeDefined();
    expect(res.body.order.status).toBe('PLACED');
    // New: orders array has both
    expect(res.body.orders).toHaveLength(2);
    const outletNames = (res.body.orders as { outlet: { name: string } }[]).map(
      (o) => o.outlet.name,
    );
    expect(outletNames).toContain('Night Owl Café');
    expect(outletNames).toContain('Tandoor Corner');

    // Wallet debited for grand total
    const balance = (await s.get('/api/v1/wallet').expect(200)).body.wallet.balancePaise;
    expect(balance).toBe(20000 - total);

    // Cart cleared
    const cart = (await s.get('/api/v1/cart').expect(200)).body.cart;
    expect(cart.items).toHaveLength(0);

    // Both orders have the same batchKey
    const allOrders = await prisma.order.findMany({ orderBy: { placedAt: 'asc' } });
    expect(allOrders).toHaveLength(2);
    expect(allOrders[0]!.batchKey).toBeTruthy();
    expect(allOrders[0]!.batchKey).toBe(allOrders[1]!.batchKey);
  });

  it('per-order totals sum to the grand total', async () => {
    await fund(s, 20000);
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const total = 2000 + 4500;

    const res = await placeOrder(s, 'WALLET', total).expect(201);
    const orderTotals = (res.body.orders as { totalPaise: number }[]).map((o) => o.totalPaise);
    expect(orderTotals.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('each outlet order creates its own wallet debit', async () => {
    await fund(s, 20000);
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);

    await placeOrder(s, 'WALLET', 2000 + 4500).expect(201);

    const debits = await prisma.walletTransaction.findMany({
      where: { type: 'ORDER_DEBIT' },
      orderBy: { amountPaise: 'asc' },
    });
    expect(debits).toHaveLength(2);
    expect(debits.map((d) => d.amountPaise).sort((a, b) => a - b)).toEqual([2000, 4500]);
  });

  it('idempotency: retrying the same key returns the same orders', async () => {
    await fund(s, 20000);
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const k = key();
    const first = await post(s, '/orders', { paymentMethod: 'WALLET', expectedTotalPaise: 6500 }, k).expect(201);
    const second = await post(s, '/orders', { paymentMethod: 'WALLET', expectedTotalPaise: 6500 }, k).expect(200);

    const firstIds = new Set((first.body.orders as { id: string }[]).map((o) => o.id));
    const secondIds = new Set((second.body.orders as { id: string }[]).map((o) => o.id));
    expect(firstIds).toEqual(secondIds);
    expect(await prisma.order.count()).toBe(2);
  });

  it('rejects stale total including both outlets', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const res = await placeOrder(s, 'COUNTER', 9999); // wrong total
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(res.body.error.details.totalPaise).toBe(6500);
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects when one outlet is closed', async () => {
    await prisma.outlet.update({ where: { id: outlet2.id }, data: { status: 'CLOSED' } });
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const res = await placeOrder(s, 'COUNTER', 6500);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUTLET_NOT_ACCEPTING');
    expect(await prisma.order.count()).toBe(0);
  });

  it('rolls back all orders if wallet is short for the grand total', async () => {
    await fund(s, 4000); // enough for chai (₹20) but not roll (₹45) combined
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const res = await placeOrder(s, 'WALLET', 6500);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { type: 'ORDER_DEBIT' } })).toBe(0);
  });

  it('counter payment creates both orders as PENDING_COUNTER', async () => {
    await addToCart(s, m.chai.id);
    await addToCart(s, item2.id);
    const res = await placeOrder(s, 'COUNTER', 6500).expect(201);
    const statuses = (res.body.orders as { paymentStatus: string }[]).map((o) => o.paymentStatus);
    expect(statuses).toEqual(['PENDING_COUNTER', 'PENDING_COUNTER']);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it('single-outlet checkout still returns backward-compat response', async () => {
    await fund(s, 10000);
    await addToCart(s, m.chai.id);
    const res = await placeOrder(s, 'WALLET', 2000).expect(201);
    // Must have both order and orders
    expect(res.body.order).toBeDefined();
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.order.id).toBe(res.body.orders[0].id);
  });
});

// ─── Points with multi-outlet ─────────────────────────────────────────────────

describe('loyalty points with multi-outlet checkout', () => {
  it('distributes points pro-rata across outlet orders', async () => {
    await fund(s, 20000);
    // Give points: 2 points = ₹2 discount
    await prisma.wallet.update({
      where: { userId: (await prisma.user.findFirstOrThrow({ where: { email: 'student@example.com' } })).id },
      data: { pointsBalance: { increment: 2 } },
    });

    await addToCart(s, m.chai.id); // Night Owl ₹20
    await addToCart(s, item2.id); // Tandoor ₹45

    // Total subtotal = 6500. Points discount = 200 (2 points × 100).
    // After discount: 6300.
    const res = await post(s, '/orders', {
      paymentMethod: 'WALLET',
      expectedTotalPaise: 6300,
      pointsToRedeem: 2,
    }, key()).expect(201);

    const totalPoints = (res.body.orders as { pointsRedeemed: number }[]).reduce(
      (sum, o) => sum + o.pointsRedeemed,
      0,
    );
    expect(totalPoints).toBe(2);
    const totalDiscount = (res.body.orders as { pointsDiscountPaise: number }[]).reduce(
      (sum, o) => sum + o.pointsDiscountPaise,
      0,
    );
    expect(totalDiscount).toBe(200);
  });
});
