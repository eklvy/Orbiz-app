import type { Database, DbClient } from '../../lib/prisma.js';
import { isUniqueViolation } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  FeedbackLevel,
  FoodReviewReportReason,
  FoodReviewStatus,
} from '../../generated/prisma/enums.js';
import { ratingDetail, roundRating } from './ratings.js';

/*
 * Food ratings & reviews.
 *
 * Policy (docs/food-reviews.md):
 *  - One review per student per menu item. Buying the dish again doesn't add a review; the
 *    student edits the one they have. A repeated or concurrent submit can't create a second
 *    row (unique [userId, menuItemId]).
 *  - Eligible = the student has a COMPLETED, PAID order containing the item. For a group order
 *    that means a group member who put the dish on the tray (the order belongs to the host).
 *    Cancelled, rejected, no-show and unpaid orders never qualify. Checked in the database on
 *    every create; the client sends only the item id and the review.
 *  - Reviews are published immediately (post-moderation). Students can report a review; the
 *    outlet's manager can hide or restore it. Hidden reviews leave public lists and summaries.
 *  - Students can delete their own review (they may write a new one later if still eligible).
 */

export const PAGE_SIZE_MAX = 50;
const DAY_MS = 86_400_000;
/** Manager trend window: last 30 days vs the 30 before. */
const TREND_DAYS = 30;
/** Average change (stars) that counts as improving / declining. */
const TREND_THRESHOLD = 0.3;

export type ReviewSort = 'recent' | 'highest' | 'lowest';

export interface ReviewInput {
  rating: number;
  body: string | null;
  photoUrl?: string | null;
  taste: FeedbackLevel | null;
  portion: FeedbackLevel | null;
  freshness: FeedbackLevel | null;
  value: FeedbackLevel | null;
}

/** "Asha Kumar" → "Asha K." — reviews never show emails or full names. */
export function publicName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Student';
  const first = parts[0]!.slice(0, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : first;
}

const reviewInclude = { user: { select: { displayName: true } } } as const;
type ReviewRow = Prisma.FoodReviewGetPayload<{ include: typeof reviewInclude }>;

function toPublicReview(r: ReviewRow, viewerId?: string) {
  return {
    id: r.id,
    rating: r.rating,
    body: r.body,
    photoUrl: r.photoUrl ?? null,
    helpfulCount: r.helpfulCount,
    feedback: { taste: r.taste, portion: r.portion, freshness: r.freshness, value: r.value },
    verifiedPurchase: r.verifiedPurchase,
    author: publicName(r.user.displayName),
    isMine: viewerId === r.userId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    /** Edited after it was first written (ignores the same-second create). */
    edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
  };
}

function toOwnReview(r: ReviewRow) {
  return {
    ...toPublicReview(r, r.userId),
    status: r.status,
    /** Only shown to the author when a manager hid the review. */
    moderationReason: r.status === 'HIDDEN' ? r.moderationReason : null,
  };
}

/** A dish students can see (active, active category, active outlet), or 404. */
async function visibleItem(db: DbClient, menuItemId: string) {
  const item = await db.menuItem.findFirst({
    where: {
      id: menuItemId,
      isActive: true,
      category: { isActive: true },
      outlet: { isActive: true },
    },
    include: { outlet: true, category: true },
  });
  if (!item) throw notFound('Dish not found');
  return item;
}

/**
 * The student's most recent qualifying order for this item, or null. Everything comes from the
 * database: order owner (or group-tray contribution), item on the order, status and payment.
 */
export async function qualifyingOrder(db: DbClient, userId: string, menuItemId: string) {
  return db.order.findFirst({
    where: {
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { some: { menuItemId } },
      OR: [
        { userId, paymentMethod: { not: 'GROUP' } },
        {
          paymentMethod: 'GROUP',
          groupTray: { items: { some: { menuItemId, member: { userId } } } },
        },
      ],
    },
    orderBy: { placedAt: 'desc' },
    select: { id: true, outletId: true, placedAt: true },
  });
}

/** Item page header: the dish, its outlet and the full rating breakdown. */
export async function itemWithRatings(db: Database, menuItemId: string) {
  const item = await visibleItem(db, menuItemId);
  return { item, rating: await ratingDetail(db, menuItemId) };
}

export async function itemRatings(db: Database, menuItemId: string) {
  await visibleItem(db, menuItemId);
  return ratingDetail(db, menuItemId);
}

/** Published reviews for one item, page by page. */
export async function listItemReviews(
  db: Database,
  menuItemId: string,
  opts: { sort: ReviewSort; page: number; pageSize: number; viewerId?: string },
) {
  await visibleItem(db, menuItemId);
  const where = { menuItemId, status: 'PUBLISHED' as FoodReviewStatus };
  const orderBy: Prisma.FoodReviewOrderByWithRelationInput[] =
    opts.sort === 'highest'
      ? [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]
      : opts.sort === 'lowest'
        ? [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }]
        : [{ createdAt: 'desc' }, { id: 'asc' }];
  const [total, rows] = await Promise.all([
    db.foodReview.count({ where }),
    db.foodReview.findMany({
      where,
      orderBy,
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: reviewInclude,
    }),
  ]);
  return {
    reviews: rows.map((r) => toPublicReview(r, opts.viewerId)),
    page: opts.page,
    pageSize: opts.pageSize,
    total,
    hasMore: opts.page * opts.pageSize < total,
  };
}

/** Whether the signed-in student may review this item, and their review if they have one. */
export async function myReviewFor(db: Database, userId: string, menuItemId: string) {
  await visibleItem(db, menuItemId);
  const [review, order] = await Promise.all([
    db.foodReview.findUnique({
      where: { userId_menuItemId: { userId, menuItemId } },
      include: reviewInclude,
    }),
    qualifyingOrder(db, userId, menuItemId),
  ]);
  return { eligible: order !== null, review: review ? toOwnReview(review) : null };
}

export async function createReview(
  db: Database,
  userId: string,
  menuItemId: string,
  input: ReviewInput,
) {
  const item = await visibleItem(db, menuItemId);
  const order = await qualifyingOrder(db, userId, menuItemId);
  if (!order) {
    throw new AppError(
      403,
      'NOT_ELIGIBLE',
      'You can rate a dish after you’ve collected an order with it.',
    );
  }
  const existing = await db.foodReview.findUnique({
    where: { userId_menuItemId: { userId, menuItemId } },
    select: { id: true },
  });
  if (existing) throw reviewExists(existing.id);
  try {
    const review = await db.foodReview.create({
      data: {
        userId,
        menuItemId,
        outletId: item.outletId,
        orderId: order.id,
        verifiedPurchase: true,
        ...input,
      },
      include: reviewInclude,
    });
    return toOwnReview(review);
  } catch (err) {
    // Two submits at once: the unique constraint lets exactly one through.
    if (isUniqueViolation(err)) {
      const winner = await db.foodReview.findUnique({
        where: { userId_menuItemId: { userId, menuItemId } },
        select: { id: true },
      });
      throw reviewExists(winner?.id ?? null);
    }
    throw err;
  }
}

const reviewExists = (reviewId: string | null) =>
  new AppError(
    409,
    'REVIEW_EXISTS',
    'You’ve already reviewed this dish — edit your review instead.',
    {
      reviewId,
    },
  );

/** Only the author can find their review here; anyone else gets the same 404. */
async function ownReview(db: DbClient, userId: string, reviewId: string) {
  const review = await db.foodReview.findFirst({ where: { id: reviewId, userId } });
  if (!review) throw notFound('Review not found');
  return review;
}

/** Updates the existing row in place (never creates another). A hidden review stays hidden. */
export async function updateReview(
  db: Database,
  userId: string,
  reviewId: string,
  patch: Partial<ReviewInput>,
) {
  await ownReview(db, userId, reviewId);
  const review = await db.foodReview.update({
    where: { id: reviewId },
    data: patch,
    include: reviewInclude,
  });
  return toOwnReview(review);
}

export async function deleteReview(db: Database, userId: string, reviewId: string) {
  await ownReview(db, userId, reviewId);
  await db.foodReview.delete({ where: { id: reviewId } });
}

/** The student's own reviews (including hidden ones, with the reason), newest change first. */
export async function listMyReviews(
  db: Database,
  userId: string,
  opts: { page: number; pageSize: number },
) {
  const where = { userId };
  const [total, rows] = await Promise.all([
    db.foodReview.count({ where }),
    db.foodReview.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        ...reviewInclude,
        menuItem: { select: { id: true, name: true, isActive: true } },
        outlet: { select: { slug: true, name: true } },
      },
    }),
  ]);
  return {
    reviews: rows.map((r) => ({
      ...toOwnReview(r),
      item: { id: r.menuItem.id, name: r.menuItem.name, isActive: r.menuItem.isActive },
      outlet: r.outlet,
    })),
    page: opts.page,
    pageSize: opts.pageSize,
    total,
    hasMore: opts.page * opts.pageSize < total,
  };
}

/** Flags a published review for the outlet's manager. Repeating it changes nothing. */
export async function reportReview(
  db: Database,
  userId: string,
  reviewId: string,
  reason: FoodReviewReportReason,
  note: string | null,
) {
  const review = await db.foodReview.findFirst({
    where: { id: reviewId, status: 'PUBLISHED', menuItem: { isActive: true } },
    select: { userId: true },
  });
  if (!review) throw notFound('Review not found');
  if (review.userId === userId) {
    throw new AppError(400, 'OWN_REVIEW', 'You can’t report your own review.');
  }
  try {
    await db.foodReviewReport.create({ data: { reviewId, userId, reason, note } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

// ─── Outlet staff (manager) ──────────────────────────────────────────────────

export type OutletReviewFilter = 'all' | 'reported' | 'hidden';

/** Reviews of this outlet's dishes for moderation. Names are shortened like the public view. */
export async function listOutletReviews(
  db: Database,
  outletId: string,
  opts: { filter: OutletReviewFilter; page: number; pageSize: number },
) {
  const where: Prisma.FoodReviewWhereInput = {
    outletId,
    ...(opts.filter === 'hidden' && { status: 'HIDDEN' }),
    ...(opts.filter === 'reported' && {
      status: 'PUBLISHED',
      reports: { some: { resolvedAt: null } },
    }),
  };
  const [total, rows] = await Promise.all([
    db.foodReview.count({ where }),
    db.foodReview.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        ...reviewInclude,
        menuItem: { select: { id: true, name: true } },
        reports: { where: { resolvedAt: null }, select: { reason: true, note: true } },
      },
    }),
  ]);
  return {
    reviews: rows.map((r) => ({
      ...toPublicReview(r),
      status: r.status,
      moderationReason: r.moderationReason,
      moderatedAt: r.moderatedAt?.toISOString() ?? null,
      item: r.menuItem,
      openReports: r.reports.length,
      reportReasons: [...new Set(r.reports.map((x) => x.reason))],
    })),
    page: opts.page,
    pageSize: opts.pageSize,
    total,
    hasMore: opts.page * opts.pageSize < total,
  };
}

/**
 * hide: removes a review from public view and summaries. restore: publishes it again.
 * keep: leaves it published and closes its open reports. All resolve open reports and are audited.
 */
export async function moderateReview(
  db: Database,
  input: {
    outletId: string;
    reviewId: string;
    managerUserId: string;
    action: 'hide' | 'restore' | 'keep';
    reason?: string;
  },
) {
  await db.$transaction(async (tx) => {
    const review = await tx.foodReview.findFirst({
      where: { id: input.reviewId, outletId: input.outletId },
    });
    if (!review) throw notFound('Review not found');
    const now = new Date();
    if (input.action === 'hide') {
      if (!input.reason) {
        throw new AppError(400, 'REASON_REQUIRED', 'Say why the review is being hidden.');
      }
      await tx.foodReview.update({
        where: { id: review.id },
        data: {
          status: 'HIDDEN',
          moderatedById: input.managerUserId,
          moderatedAt: now,
          moderationReason: input.reason,
        },
      });
    } else if (input.action === 'restore') {
      if (review.status !== 'HIDDEN') {
        throw new AppError(409, 'NOT_HIDDEN', 'This review isn’t hidden.');
      }
      await tx.foodReview.update({
        where: { id: review.id },
        data: {
          status: 'PUBLISHED',
          moderatedById: input.managerUserId,
          moderatedAt: now,
          moderationReason: null,
        },
      });
    }
    await tx.foodReviewReport.updateMany({
      where: { reviewId: review.id, resolvedAt: null },
      data: { resolvedAt: now },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: input.managerUserId },
      action: `FOOD_REVIEW_${input.action.toUpperCase()}`,
      entityType: 'FoodReview',
      entityId: review.id,
      metadata: { outletId: input.outletId, reason: input.reason ?? null },
    });
  });
}

/**
 * Outlet analytics from published reviews: overall average and distribution, per-dish averages
 * with a 30-day trend, and the latest written feedback. No student details beyond short names.
 */
export async function outletReviewSummary(db: Database, outletId: string, now = new Date()) {
  const published = { outletId, status: 'PUBLISHED' as FoodReviewStatus };
  const recentFrom = new Date(now.getTime() - TREND_DAYS * DAY_MS);
  const priorFrom = new Date(now.getTime() - 2 * TREND_DAYS * DAY_MS);

  const [byStars, byItem, recentByItem, priorByItem, latest, openReports] = await Promise.all([
    db.foodReview.groupBy({ by: ['rating'], where: published, _count: { _all: true } }),
    db.foodReview.groupBy({
      by: ['menuItemId'],
      where: published,
      _sum: { rating: true },
      _count: { _all: true },
    }),
    db.foodReview.groupBy({
      by: ['menuItemId'],
      where: { ...published, createdAt: { gte: recentFrom } },
      _sum: { rating: true },
      _count: { _all: true },
    }),
    db.foodReview.groupBy({
      by: ['menuItemId'],
      where: { ...published, createdAt: { gte: priorFrom, lt: recentFrom } },
      _sum: { rating: true },
      _count: { _all: true },
    }),
    db.foodReview.findMany({
      where: { ...published, body: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 5,
      include: { ...reviewInclude, menuItem: { select: { id: true, name: true } } },
    }),
    db.foodReview.count({
      where: { ...published, reports: { some: { resolvedAt: null } } },
    }),
  ]);

  const counts = new Map(byStars.map((g) => [g.rating, g._count._all]));
  const distribution = ([5, 4, 3, 2, 1] as const).map((stars) => ({
    stars,
    count: counts.get(stars) ?? 0,
  }));
  const total = distribution.reduce((s, d) => s + d.count, 0);
  const sum = distribution.reduce((s, d) => s + d.stars * d.count, 0);

  const names = new Map(
    (
      await db.menuItem.findMany({
        where: { id: { in: byItem.map((g) => g.menuItemId) } },
        select: { id: true, name: true },
      })
    ).map((i) => [i.id, i.name]),
  );
  const avgOf = (g?: { _sum: { rating: number | null }; _count: { _all: number } }) =>
    g && g._count._all > 0 ? (g._sum.rating ?? 0) / g._count._all : null;
  const items = byItem
    .map((g) => {
      const recent = avgOf(recentByItem.find((x) => x.menuItemId === g.menuItemId));
      const prior = avgOf(priorByItem.find((x) => x.menuItemId === g.menuItemId));
      const change = recent !== null && prior !== null ? recent - prior : null;
      return {
        id: g.menuItemId,
        name: names.get(g.menuItemId) ?? 'Dish',
        average: roundRating((g._sum.rating ?? 0) / g._count._all),
        count: g._count._all,
        recentAverage: recent === null ? null : roundRating(recent),
        priorAverage: prior === null ? null : roundRating(prior),
        trend:
          change === null
            ? ('NOT_ENOUGH_DATA' as const)
            : change >= TREND_THRESHOLD
              ? ('IMPROVING' as const)
              : change <= -TREND_THRESHOLD
                ? ('DECLINING' as const)
                : ('STEADY' as const),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    average: total === 0 ? null : roundRating(sum / total),
    total,
    distribution,
    openReports,
    trendWindowDays: TREND_DAYS,
    items,
    recentFeedback: latest.map((r) => ({ ...toPublicReview(r), item: r.menuItem })),
  };
}

// ─── Community feed ───────────────────────────────────────────────────────────

export interface CommunityFeedOptions {
  outletId?: string;
  menuItemId?: string;
  page: number;
  pageSize: number;
  viewerId?: string;
}

/**
 * Campus-wide community feed: all PUBLISHED reviews, newest first.
 * Optionally filtered by outlet or specific menu item.
 */
export async function listCommunityFeed(db: Database, opts: CommunityFeedOptions) {
  const where: Prisma.FoodReviewWhereInput = {
    status: 'PUBLISHED',
    ...(opts.outletId && { outletId: opts.outletId }),
    ...(opts.menuItemId && { menuItemId: opts.menuItemId }),
  };
  const [total, rows] = await Promise.all([
    db.foodReview.count({ where }),
    db.foodReview.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        ...reviewInclude,
        menuItem: { select: { id: true, name: true } },
        outlet: { select: { id: true, slug: true, name: true } },
      },
    }),
  ]);
  return {
    reviews: rows.map((r) => ({
      ...toPublicReview(r, opts.viewerId),
      item: { id: r.menuItem.id, name: r.menuItem.name },
      outlet: r.outlet,
    })),
    page: opts.page,
    pageSize: opts.pageSize,
    total,
    hasMore: opts.page * opts.pageSize < total,
  };
}

// ─── Helpful likes ────────────────────────────────────────────────────────────

/**
 * Toggles a student's helpful like on a published review.
 * Returns the new liked state and updated helpfulCount.
 */
export async function toggleHelpfulLike(
  db: Database,
  reviewId: string,
  userId: string,
): Promise<{ liked: boolean; helpfulCount: number }> {
  return db.$transaction(async (tx) => {
    const review = await tx.foodReview.findFirst({
      where: { id: reviewId, status: 'PUBLISHED' },
      select: { id: true },
    });
    if (!review) throw notFound('Review not found');

    const existing = await tx.reviewLike.findUnique({
      where: { reviewId_userId: { reviewId, userId } },
      select: { id: true },
    });

    if (existing) {
      await tx.reviewLike.delete({ where: { reviewId_userId: { reviewId, userId } } });
      const updated = await tx.foodReview.update({
        where: { id: reviewId },
        data: { helpfulCount: { decrement: 1 } },
        select: { helpfulCount: true },
      });
      return { liked: false, helpfulCount: Math.max(0, updated.helpfulCount) };
    } else {
      await tx.reviewLike.create({ data: { reviewId, userId } });
      const updated = await tx.foodReview.update({
        where: { id: reviewId },
        data: { helpfulCount: { increment: 1 } },
        select: { helpfulCount: true },
      });
      return { liked: true, helpfulCount: updated.helpfulCount };
    }
  });
}
