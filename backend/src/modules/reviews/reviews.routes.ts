import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import { toCategory, toMenuItem, toOutletSummary } from '../outlets/outlets.serializer.js';
import {
  createReview,
  deleteReview,
  itemRatings,
  itemWithRatings,
  listCommunityFeed,
  listItemReviews,
  listMyReviews,
  listOutletReviews,
  moderateReview,
  myReviewFor,
  outletReviewSummary,
  PAGE_SIZE_MAX,
  reportReview,
  toggleHelpfulLike,
  updateReview,
} from './reviews.service.js';

// Strips control characters (keeps newlines and tabs); React escapes the rest when rendering.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const clean = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

const level = z.enum(['POOR', 'OKAY', 'GREAT']).nullable();
const reviewFields = {
  rating: z
    .number()
    .int('Choose 1 to 5 stars')
    .min(1, 'Choose 1 to 5 stars')
    .max(5, 'Choose 1 to 5 stars'),
  /** Optional; an empty review is stored as no review. */
  body: z
    .string()
    .transform(clean)
    .pipe(z.string().trim().max(1000, 'Keep your review under 1000 characters'))
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  /** Optional URL of a photo uploaded via POST /uploads/review-photos. */
  photoUrl: z.url().max(1000).nullable(),
  taste: level,
  portion: level,
  freshness: level,
  value: level,
};
const createBody = z
  .object({
    rating: reviewFields.rating,
    body: reviewFields.body.default(null),
    photoUrl: reviewFields.photoUrl.default(null),
    taste: level.default(null),
    portion: level.default(null),
    freshness: level.default(null),
    value: level.default(null),
  })
  .strict();
const updateBody = z
  .object(reviewFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
const reportBody = z
  .object({
    reason: z.enum(['OFFENSIVE', 'SPAM', 'NOT_ABOUT_FOOD', 'PERSONAL_INFO', 'OTHER']),
    note: z
      .string()
      .transform(clean)
      .pipe(z.string().trim().max(300))
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
  })
  .strict();
const moderateBody = z
  .object({
    reason: z.string().transform(clean).pipe(z.string().trim().min(1).max(300)).optional(),
  })
  .strict();

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(10);
const reviewsQuery = z.object({
  sort: z.enum(['recent', 'highest', 'lowest']).default('recent'),
  page,
  pageSize,
});
const pageQuery = z.object({ page, pageSize });
const communityFeedQuery = z.object({
  outletId: z.uuid().optional(),
  menuItemId: z.uuid().optional(),
  page,
  pageSize,
});
const outletQuery = z.object({
  filter: z.enum(['all', 'reported', 'hidden']).default('all'),
  page,
  pageSize,
});

const idParam = (req: Request, key: string, what: string) => {
  const parsed = z.uuid().safeParse(req.params[key]);
  if (!parsed.success) throw notFound(`${what} not found`);
  return parsed.data;
};

/** /api/v1/menu-items/:itemId — dish detail and reviews (public reads, student writes). */
export function menuItemReviewsRouter(db: Database) {
  const router = Router();

  router.get('/:itemId', async (req, res) => {
    const { item, rating } = await itemWithRatings(db, idParam(req, 'itemId', 'Dish'));
    res.json({
      item: { ...toMenuItem(item), rating },
      category: toCategory(item.category),
      outlet: toOutletSummary(item.outlet),
    });
  });

  router.get('/:itemId/ratings', async (req, res) => {
    res.json({ rating: await itemRatings(db, idParam(req, 'itemId', 'Dish')) });
  });

  router.get('/:itemId/reviews', async (req, res) => {
    const query = reviewsQuery.parse(req.query);
    res.json(
      await listItemReviews(db, idParam(req, 'itemId', 'Dish'), {
        ...query,
        viewerId: req.auth?.user.id,
      }),
    );
  });

  /** Can I review this dish, and what did I write? */
  router.get('/:itemId/my-review', requireRole('STUDENT'), async (req, res) => {
    res.json(await myReviewFor(db, req.auth!.user.id, idParam(req, 'itemId', 'Dish')));
  });

  router.post('/:itemId/reviews', requireRole('STUDENT'), async (req, res) => {
    const itemId = idParam(req, 'itemId', 'Dish');
    const body = createBody.parse(req.body);
    const review = await createReview(db, req.auth!.user.id, itemId, body);
    res.status(201).json({ review, rating: await itemRatings(db, itemId) });
  });

  return router;
}

/**
 * /api/v1/reviews
 * Public: GET / — community feed (all published reviews, newest first).
 * Student: PATCH/DELETE /:reviewId — edit or delete own review.
 * Student: POST /:reviewId/report — report a review.
 * Student: POST /:reviewId/helpful — toggle helpful like.
 */
export function reviewsRouter(db: Database) {
  const router = Router();

  // ─── Public route ──────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    const query = communityFeedQuery.parse(req.query);
    res.json(
      await listCommunityFeed(db, {
        ...query,
        viewerId: req.auth?.user.id,
      }),
    );
  });

  // ─── Student-only routes ───────────────────────────────────────────────────
  router.use(requireRole('STUDENT'));

  router.patch('/:reviewId', async (req, res) => {
    const patch = updateBody.parse(req.body);
    res.json({
      review: await updateReview(db, req.auth!.user.id, idParam(req, 'reviewId', 'Review'), patch),
    });
  });

  router.delete('/:reviewId', async (req, res) => {
    await deleteReview(db, req.auth!.user.id, idParam(req, 'reviewId', 'Review'));
    res.status(204).end();
  });

  router.post('/:reviewId/report', async (req, res) => {
    const { reason, note } = reportBody.parse(req.body);
    await reportReview(db, req.auth!.user.id, idParam(req, 'reviewId', 'Review'), reason, note);
    res.json({ reported: true });
  });

  router.post('/:reviewId/helpful', async (req, res) => {
    const result = await toggleHelpfulLike(
      db,
      idParam(req, 'reviewId', 'Review'),
      req.auth!.user.id,
    );
    res.json(result);
  });

  return router;
}

/** /api/v1/me/reviews — the signed-in student's reviews. */
export function myReviewsRouter(db: Database) {
  const router = Router();
  router.use(requireRole('STUDENT'));
  router.get('/', async (req, res) => {
    res.json(await listMyReviews(db, req.auth!.user.id, pageQuery.parse(req.query)));
  });
  return router;
}

/**
 * /api/v1/staff/outlets/:outletId/reviews — the outlet's MANAGER only: analytics and moderation.
 * POS staff can't see or change reviews, and nobody here can edit a rating or write one.
 */
export function staffReviewsRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth, requireOutletRole(db, 'MANAGER'));
  const outletOf = (req: Request) => idParam(req, 'outletId', 'Outlet');

  router.get('/summary', async (req, res) => {
    res.json({ summary: await outletReviewSummary(db, outletOf(req)) });
  });

  router.get('/', async (req, res) => {
    res.json(await listOutletReviews(db, outletOf(req), outletQuery.parse(req.query)));
  });

  for (const action of ['hide', 'restore', 'keep'] as const) {
    router.post(`/:reviewId/${action}`, async (req, res) => {
      const { reason } = moderateBody.parse(req.body ?? {});
      await moderateReview(db, {
        outletId: outletOf(req),
        reviewId: idParam(req, 'reviewId', 'Review'),
        managerUserId: req.auth!.user.id,
        action,
        reason,
      });
      res.json({ ok: true });
    });
  }

  return router;
}
