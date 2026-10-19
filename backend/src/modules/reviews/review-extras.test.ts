/**
 * Tests for: review photos, community feed, and helpful likes.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../../tests/db.js';
import {
  addToCart,
  fund,
  menu,
  placeOrder,
  student,
  type Agent,
} from '../../tests/commerce.js';
import { staffApp, staffFor, transition } from '../../tests/staff.js';

const H = { 'X-Requested-With': 'CampusCart' };
const anon = () => request(staffApp);

const api = (
  agent: Agent,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body?: object,
) => {
  const req = agent[method](`/api/v1${url}`).set(H);
  return body ? req.send(body) : req;
};

let m: Awaited<ReturnType<typeof menu>>;
let manager: Agent;
let asha: Agent;
let ben: Agent;
let n = 0;

beforeEach(async () => {
  await resetDatabase();
  n += 1;
  m = await menu();
  ({ manager } = await staffFor(m.outlet.id));
  asha = await student(`asha${n}@example.com`, staffApp);
  ben = await student(`ben${n}@example.com`, staffApp);
});

/** Places and completes a wallet order for the given item. */
async function completedOrder(agent: Agent, itemId: string, pricePaise: number) {
  await fund(agent, 10_000);
  await addToCart(agent, itemId);
  const o = (await placeOrder(agent, 'WALLET', pricePaise).expect(201)).body.order as {
    id: string;
  };
  await transition(manager, m.outlet.id, o.id, 'READY').expect(200);
  await transition(manager, m.outlet.id, o.id, 'COMPLETED').expect(200);
  return o.id;
}

/** Submits a minimal valid review and returns the review id. */
async function postReview(agent: Agent, itemId: string, rating = 4) {
  const res = await api(agent, 'post', `/menu-items/${itemId}/reviews`, {
    rating,
    body: 'Tasty!',
  }).expect(201);
  return res.body.review.id as string;
}

// ─── Community feed ────────────────────────────────────────────────────────────

describe('GET /api/v1/reviews — community feed', () => {
  it('returns empty feed when no reviews exist', async () => {
    const res = await anon().get('/api/v1/reviews').set(H).expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.reviews).toHaveLength(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns published reviews with item and outlet info', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await postReview(asha, m.chai.id);

    const res = await anon().get('/api/v1/reviews').set(H).expect(200);
    expect(res.body.total).toBe(1);
    const r = res.body.reviews[0];
    expect(r).toHaveProperty('id');
    expect(r).toHaveProperty('rating', 4);
    expect(r).toHaveProperty('helpfulCount', 0);
    expect(r).toHaveProperty('photoUrl', null);
    expect(r.item).toHaveProperty('name', 'Chai');
    expect(r.outlet).toHaveProperty('slug');
  });

  it('filters by outletId', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await postReview(asha, m.chai.id);

    const res = await anon()
      .get(`/api/v1/reviews?outletId=${m.outlet.id}`)
      .set(H)
      .expect(200);
    expect(res.body.total).toBe(1);
  });

  it('filters by menuItemId', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await postReview(asha, m.chai.id);

    const res = await anon()
      .get(`/api/v1/reviews?menuItemId=${m.chai.id}`)
      .set(H)
      .expect(200);
    expect(res.body.total).toBe(1);
  });

  it('returns newest reviews first', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await completedOrder(ben, m.puff.id, 3500);
    await postReview(asha, m.chai.id, 3);
    await postReview(ben, m.puff.id, 5);

    const res = await anon().get('/api/v1/reviews?pageSize=10').set(H).expect(200);
    expect(res.body.total).toBe(2);
    // Most recent review first
    expect(res.body.reviews[0].rating).toBe(5); // ben's puff review
    expect(res.body.reviews[1].rating).toBe(3); // asha's chai review
  });

  it('paginates correctly', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await completedOrder(ben, m.puff.id, 3500);
    await postReview(asha, m.chai.id, 3);
    await postReview(ben, m.puff.id, 5);

    const page1 = await anon().get('/api/v1/reviews?pageSize=1&page=1').set(H).expect(200);
    expect(page1.body.reviews).toHaveLength(1);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await anon().get('/api/v1/reviews?pageSize=1&page=2').set(H).expect(200);
    expect(page2.body.reviews).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);
    expect(page1.body.reviews[0].id).not.toBe(page2.body.reviews[0].id);
  });

  it('no auth required for community feed', async () => {
    // Unauthenticated user (no cookie) can access the feed
    await anon().get('/api/v1/reviews').set(H).expect(200);
  });
});

// ─── Review photos ─────────────────────────────────────────────────────────────

describe('photoUrl on reviews', () => {
  it('photoUrl defaults to null', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const res = await api(asha, 'post', `/menu-items/${m.chai.id}/reviews`, {
      rating: 4,
      body: 'Good chai',
    }).expect(201);
    expect(res.body.review.photoUrl).toBeNull();
  });

  it('accepts a valid https photoUrl', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const photoUrl = 'https://example.com/photo.jpg';
    const res = await api(asha, 'post', `/menu-items/${m.chai.id}/reviews`, {
      rating: 4,
      body: 'Good chai',
      photoUrl,
    }).expect(201);
    expect(res.body.review.photoUrl).toBe(photoUrl);
  });

  it('rejects an invalid photoUrl (not a URL)', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    await api(asha, 'post', `/menu-items/${m.chai.id}/reviews`, {
      rating: 4,
      body: 'Good chai',
      photoUrl: 'not-a-url',
    }).expect(400);
  });

  it('photoUrl returned in community feed', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const photoUrl = 'https://example.com/photo.jpg';
    await api(asha, 'post', `/menu-items/${m.chai.id}/reviews`, {
      rating: 4,
      photoUrl,
    }).expect(201);

    const feed = await anon().get('/api/v1/reviews').set(H).expect(200);
    expect(feed.body.reviews[0].photoUrl).toBe(photoUrl);
  });

  it('student can update photoUrl via PATCH', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);

    const photoUrl = 'https://example.com/updated.jpg';
    const res = await api(asha, 'patch', `/reviews/${reviewId}`, { photoUrl }).expect(200);
    expect(res.body.review.photoUrl).toBe(photoUrl);
  });
});

// ─── Helpful likes ─────────────────────────────────────────────────────────────

describe('POST /api/v1/reviews/:reviewId/helpful', () => {
  it('student can like a review', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);

    // ben likes it
    await completedOrder(ben, m.puff.id, 3500);
    const res = await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    expect(res.body.liked).toBe(true);
    expect(res.body.helpfulCount).toBe(1);
  });

  it('helpfulCount is returned in item reviews', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);
    await completedOrder(ben, m.puff.id, 3500);
    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);

    const res = await anon()
      .get(`/api/v1/menu-items/${m.chai.id}/reviews`)
      .set(H)
      .expect(200);
    expect(res.body.reviews[0].helpfulCount).toBe(1);
  });

  it('toggling again unlikes and decrements count', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);
    await completedOrder(ben, m.puff.id, 3500);

    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    const unlike = await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    expect(unlike.body.liked).toBe(false);
    expect(unlike.body.helpfulCount).toBe(0);
  });

  it('duplicate likes from the same student are idempotent (toggle back to 0)', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);
    await completedOrder(ben, m.puff.id, 3500);

    // Like, like again (should unlike), like again (should like)
    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    const third = await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    expect(third.body.liked).toBe(true);
    expect(third.body.helpfulCount).toBe(1);
  });

  it('unauthenticated user cannot like', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);

    await anon().post(`/api/v1/reviews/${reviewId}/helpful`).set(H).expect(401);
  });

  it('returns 404 for a hidden review', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);

    // Manager hides it
    await api(manager, 'post', `/staff/outlets/${m.outlet.id}/reviews/${reviewId}/hide`, {
      reason: 'Spam',
    }).expect(200);

    await completedOrder(ben, m.puff.id, 3500);
    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(404);
  });

  it('multiple students can like the same review', async () => {
    await completedOrder(asha, m.chai.id, 2000);
    const reviewId = await postReview(asha, m.chai.id);

    await completedOrder(ben, m.puff.id, 3500);
    await api(ben, 'post', `/reviews/${reviewId}/helpful`).expect(200);

    // Third student
    const carol = await student(`carol${n}@example.com`, staffApp);
    await fund(carol, 10_000);
    await addToCart(carol, m.chai.id);
    const o = (await placeOrder(carol, 'WALLET', 2000).expect(201)).body.order as { id: string };
    await transition(manager, m.outlet.id, o.id, 'READY').expect(200);
    await transition(manager, m.outlet.id, o.id, 'COMPLETED').expect(200);
    const res = await api(carol, 'post', `/reviews/${reviewId}/helpful`).expect(200);
    expect(res.body.helpfulCount).toBe(2);
  });
});

// ─── Upload endpoint ───────────────────────────────────────────────────────────

describe('POST /api/v1/uploads/review-photos', () => {
  it('returns 401 for unauthenticated requests', async () => {
    await anon()
      .post('/api/v1/uploads/review-photos')
      .set(H)
      .attach('photo', Buffer.from('x'), { filename: 'test.jpg', contentType: 'image/jpeg' })
      .expect(401);
  });

  it('rejects an unsupported MIME type', async () => {
    // Upload a text file as image/gif
    await asha
      .post('/api/v1/uploads/review-photos')
      .set(H)
      .attach('photo', Buffer.from('GIF89a'), { filename: 'test.gif', contentType: 'image/gif' })
      .expect(415);
  });

  it('rejects a file that claims to be JPEG but has wrong magic bytes', async () => {
    // Send garbage data that doesn't start with FF D8 FF
    await asha
      .post('/api/v1/uploads/review-photos')
      .set(H)
      .attach('photo', Buffer.from('not-a-jpeg-at-all'), {
        filename: 'fake.jpg',
        contentType: 'image/jpeg',
      })
      .expect(415);
  });

  it('accepts a valid JPEG and returns a URL', async () => {
    // Minimal JPEG-like magic bytes followed by data
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0x00)]);
    const res = await asha
      .post('/api/v1/uploads/review-photos')
      .set(H)
      .attach('photo', jpegMagic, { filename: 'photo.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(res.body).toHaveProperty('url');
    expect(res.body.url).toContain('/api/v1/uploads/');
    expect(res.body).toHaveProperty('filename');
  });

  it('rejects when no file is attached', async () => {
    await asha.post('/api/v1/uploads/review-photos').set(H).expect(400);
  });
});
