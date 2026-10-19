import type { Database } from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Dietary, SpiceLevel } from '../../generated/prisma/enums.js';
import { inStock, inStockWhere } from '../inventory/stock.js';
import { NO_RATINGS, ratingSummaries } from '../reviews/ratings.js';
import { recencyScore } from '../reorder/reorder.rules.js';
import { toMenuItem, toOutletSummary } from '../outlets/outlets.serializer.js';

/*
 * Menu search and sorting, shared by the outlet menu (GET /outlets/:slug/menu) and the
 * campus-wide menu (GET /menu). Everything is computed from live data: current menu prices,
 * stock, persisted published reviews and real order records. docs/menu-search.md explains each
 * ranking. Money stays in integer paise throughout.
 *
 * Every explicit sort shows dishes that can be ordered now before sold-out ones (sold-out dishes
 * stay visible, as on the normal menu). Ties always fall back to name, then id, so pages are stable.
 */

export const MENU_SORTS = [
  'popular',
  'price-asc',
  'price-desc',
  'quick-reorder',
  'highest-rated',
] as const;
export type MenuSort = (typeof MENU_SORTS)[number];

/** Popular: distinct collected orders containing the dish in this window. */
export const POPULAR_WINDOW_DAYS = 30;
/** A "Popular" label needs at least this many orders in the window. */
export const POPULAR_LABEL_MIN_ORDERS = 3;
/** Quick Reorder: the student's own collected orders in this window. */
export const REORDER_WINDOW_DAYS = 90;
/** Highest Rated: Bayesian average — the campus mean counts as this many extra reviews. */
export const RATING_PRIOR_WEIGHT = 3;
/** Dishes with fewer reviews rank after every dish with at least this many. */
export const MIN_REVIEWS_FOR_TOP = 3;
/** With no reviews anywhere yet, the prior mean (only matters for ordering, never shown). */
export const RATING_PRIOR_FALLBACK = 3.5;

const DAY_MS = 86_400_000;

export interface MenuSearch {
  /** Fixed for the outlet menu; optional filter for the campus menu. */
  outletId?: string;
  categoryId?: string;
  q?: string;
  dietary?: Dietary;
  spiceLevel?: SpiceLevel;
  /** Only dishes that can be ordered right now. */
  inStockOnly?: boolean;
  sort?: MenuSort;
  /** The signed-in student (Quick Reorder only ever uses their own orders). */
  viewerId?: string;
  /** Campus menu: also match the outlet's name. */
  searchOutletNames?: boolean;
  page?: number;
  pageSize?: number;
}

const contains = (text: string) => ({ contains: text, mode: 'insensitive' as const });

/** A dish students can see: active item, category and outlet. */
const visible: Prisma.MenuItemWhereInput = {
  isActive: true,
  category: { isActive: true },
  outlet: { isActive: true },
};

type Candidate = {
  id: string;
  name: string;
  pricePaise: number;
  sortOrder: number;
  isAvailable: boolean;
  trackInventory: boolean;
  stockQuantity: number | null;
  lowStockThreshold: number;
  category: { sortOrder: number; name: string };
  outlet: { name: string };
};

/** Distinct collected, paid orders per dish in the window (one count per order, whatever its history). */
async function popularity(db: Database, ids: string[], now: Date) {
  if (ids.length === 0) return new Map<string, number>();
  const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ menuItemId: string; orders: number }[]>`
    SELECT oi."menuItemId", COUNT(DISTINCT oi."orderId")::int AS orders
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE oi."menuItemId" = ANY(${ids}::uuid[])
      AND o."status" = 'COMPLETED' AND o."paymentStatus" = 'PAID' AND o."placedAt" >= ${since}
    GROUP BY oi."menuItemId"`;
  return new Map(rows.map((r) => [r.menuItemId, r.orders]));
}

/** The viewer's own collected orders per dish: how many, and the latest. */
async function myHistory(db: Database, viewerId: string, ids: string[], now: Date) {
  if (ids.length === 0) return new Map<string, { orders: number; last: Date }>();
  const since = new Date(now.getTime() - REORDER_WINDOW_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ menuItemId: string; orders: number; last: Date }[]>`
    SELECT oi."menuItemId", COUNT(DISTINCT oi."orderId")::int AS orders, MAX(o."placedAt") AS last
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    WHERE o."userId" = ${viewerId}::uuid
      AND o."status" = 'COMPLETED' AND o."paymentMethod" <> 'GROUP' AND o."placedAt" >= ${since}
      AND oi."menuItemId" = ANY(${ids}::uuid[])
    GROUP BY oi."menuItemId"`;
  return new Map(rows.map((r) => [r.menuItemId, { orders: r.orders, last: r.last }]));
}

/** Mean of all published ratings on campus (the Bayesian prior). */
async function campusMeanRating(db: Database) {
  const agg = await db.foodReview.aggregate({
    where: { status: 'PUBLISHED' },
    _avg: { rating: true },
  });
  return agg._avg.rating ?? RATING_PRIOR_FALLBACK;
}

/** Bayesian average: (prior × weight + sum of ratings) ÷ (weight + count). */
export function bayesianScore(sum: number, count: number, prior: number) {
  return (prior * RATING_PRIOR_WEIGHT + sum) / (RATING_PRIOR_WEIGHT + count);
}

/** Quick Reorder score: repeat orders, plus recency (halves every 14 days, worth up to 3 orders). */
export const reorderScore = (orders: number, daysAgo: number) => orders + 3 * recencyScore(daysAgo);

const byName = (a: Candidate, b: Candidate) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Runs a search: filters in the database, ranks from real aggregates, pages the result. */
export async function searchMenu(db: Database, search: MenuSearch, now = new Date()) {
  const q = search.q?.trim();
  const where: Prisma.MenuItemWhereInput = {
    ...visible,
    ...(search.outletId && { outletId: search.outletId }),
    ...(search.categoryId && { categoryId: search.categoryId }),
    ...(search.dietary && { dietary: search.dietary }),
    ...(search.spiceLevel && { spiceLevel: search.spiceLevel }),
    ...(search.inStockOnly && inStockWhere),
    ...(q && {
      OR: [
        { name: contains(q) },
        { description: contains(q) },
        { category: { name: contains(q) } },
        ...(search.searchOutletNames ? [{ outlet: { name: contains(q) } }] : []),
      ],
    }),
  };
  const candidates: Candidate[] = await db.menuItem.findMany({
    where,
    select: {
      id: true,
      name: true,
      pricePaise: true,
      sortOrder: true,
      isAvailable: true,
      trackInventory: true,
      stockQuantity: true,
      lowStockThreshold: true,
      category: { select: { sortOrder: true, name: true } },
      outlet: { select: { name: true } },
    },
  });
  const ids = candidates.map((c) => c.id);
  const sort = search.sort;

  // Aggregates for the whole matching set at once (no per-item queries).
  const [orders30d, mine, ratings, prior] = await Promise.all([
    sort === 'popular' ? popularity(db, ids, now) : Promise.resolve(new Map<string, number>()),
    sort === 'quick-reorder' && search.viewerId
      ? myHistory(db, search.viewerId, ids, now)
      : Promise.resolve(new Map<string, { orders: number; last: Date }>()),
    ratingSummaries(db, ids),
    sort === 'highest-rated' ? campusMeanRating(db) : Promise.resolve(RATING_PRIOR_FALLBACK),
  ]);

  const orderable = (c: Candidate) => (inStock(c) ? 0 : 1);
  const ranked = [...candidates];
  if (!sort) {
    // The outlet's own order (outlet name first on the campus menu).
    ranked.sort(
      (a, b) =>
        (search.outletId ? 0 : a.outlet.name.localeCompare(b.outlet.name)) ||
        a.category.sortOrder - b.category.sortOrder ||
        a.sortOrder - b.sortOrder ||
        byName(a, b),
    );
  } else {
    const key = (c: Candidate): number => {
      switch (sort) {
        case 'popular':
          return -(orders30d.get(c.id) ?? 0);
        case 'price-asc':
          return c.pricePaise;
        case 'price-desc':
          return -c.pricePaise;
        case 'quick-reorder': {
          const h = mine.get(c.id);
          return h ? -reorderScore(h.orders, (now.getTime() - h.last.getTime()) / DAY_MS) : 0;
        }
        case 'highest-rated': {
          const r = ratings.get(c.id);
          // Unrated dishes come after every rated one.
          return r && r.count > 0 ? -bayesianScore(r.exact * r.count, r.count, prior) : 1;
        }
      }
    };
    const tieCount = (c: Candidate) =>
      sort === 'highest-rated' ? -(ratings.get(c.id)?.count ?? 0) : 0;
    // Highest Rated groups: established (≥ MIN_REVIEWS_FOR_TOP reviews), few reviews, unrated.
    const ratingGroup = (c: Candidate) => {
      if (sort !== 'highest-rated') return 0;
      const count = ratings.get(c.id)?.count ?? 0;
      return count >= MIN_REVIEWS_FOR_TOP ? 0 : count > 0 ? 1 : 2;
    };
    const keys = new Map(ranked.map((c) => [c.id, key(c)]));
    ranked.sort(
      (a, b) =>
        orderable(a) - orderable(b) ||
        ratingGroup(a) - ratingGroup(b) ||
        keys.get(a.id)! - keys.get(b.id)! ||
        tieCount(a) - tieCount(b) ||
        byName(a, b),
    );
  }

  const total = ranked.length;
  const pageSize = search.pageSize ?? total;
  const page = search.page ?? 1;
  const pageIds = ranked.slice((page - 1) * pageSize, page * pageSize).map((c) => c.id);
  const rows = await db.menuItem.findMany({
    where: { id: { in: pageIds } },
    include: { outlet: true, category: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const items = pageIds.map((id) => {
    const row = byId.get(id)!;
    const r = ratings.get(id);
    const h = mine.get(id);
    return {
      ...toMenuItem(row),
      rating: r ? { average: r.average, count: r.count } : NO_RATINGS,
      category: { id: row.category.id, name: row.category.name },
      outlet: toOutletSummary(row.outlet),
      /** Popular sort only: real order count in the window. */
      orders30d: sort === 'popular' ? (orders30d.get(id) ?? 0) : null,
      popular: sort === 'popular' && (orders30d.get(id) ?? 0) >= POPULAR_LABEL_MIN_ORDERS,
      /** Quick Reorder only: the viewer's own history for this dish. */
      mine:
        sort === 'quick-reorder' && h
          ? { orders: h.orders, lastOrderedAt: h.last.toISOString() }
          : null,
    };
  });

  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
    sort: sort ?? null,
    quickReorder:
      sort === 'quick-reorder'
        ? {
            signedIn: Boolean(search.viewerId),
            hasHistory: mine.size > 0,
            windowDays: REORDER_WINDOW_DAYS,
          }
        : null,
    popularWindowDays: sort === 'popular' ? POPULAR_WINDOW_DAYS : null,
  };
}
