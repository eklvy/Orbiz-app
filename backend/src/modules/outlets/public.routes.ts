import { Router } from 'express';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { menuQuery, outletListQuery } from './outlets.schema.js';
import { searchMenu } from '../menu/menu-search.js';
import { studentId } from '../menu/menu.routes.js';
import { toCategory, toOutletSummary } from './outlets.serializer.js';

const contains = (text: string) => ({ contains: text, mode: 'insensitive' as const });

/** An item students can see: active, in an active category. Sold-out items are still shown. */
const visibleItem: Prisma.MenuItemWhereInput = { isActive: true, category: { isActive: true } };

/**
 * Public browsing — no sign-in needed. Archived outlets, deactivated
 * categories and deactivated items are never returned here.
 */
export function publicOutletsRouter(db: Database) {
  const router = Router();

  /** GET /outlets?q= — active outlets, open ones first. */
  router.get('/', async (req, res) => {
    const { q } = outletListQuery.parse(req.query);
    const outlets = await db.outlet.findMany({
      where: {
        isActive: true,
        ...(q && {
          OR: [
            { name: contains(q) },
            { description: contains(q) },
            { location: contains(q) },
            { items: { some: { ...visibleItem, name: contains(q) } } },
          ],
        }),
      },
      orderBy: { name: 'asc' },
    });
    const rank = { OPEN: 0, PAUSED: 1, CLOSED: 2 } as const;
    outlets.sort((a, b) => rank[a.status] - rank[b.status]);
    res.json({ outlets: outlets.map(toOutletSummary) });
  });

  /** GET /outlets/:slug */
  router.get('/:slug', async (req, res) => {
    const outlet = await db.outlet.findFirst({ where: { slug: req.params.slug, isActive: true } });
    if (!outlet) throw notFound('Outlet not found');
    res.json({ outlet: toOutletSummary(outlet) });
  });

  /** GET /outlets/:slug/menu?q=&category=&dietary=&inStock=&sort= — filtering and sorting on the server. */
  router.get('/:slug/menu', async (req, res) => {
    const filters = menuQuery.parse(req.query);
    const outlet = await db.outlet.findFirst({ where: { slug: req.params.slug, isActive: true } });
    if (!outlet) throw notFound('Outlet not found');

    const [categories, result] = await Promise.all([
      db.menuCategory.findMany({
        where: { outletId: outlet.id, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      searchMenu(db, {
        outletId: outlet.id,
        categoryId: filters.category,
        q: filters.q,
        dietary: filters.dietary,
        spiceLevel: filters.spiceLevel,
        inStockOnly: filters.inStock,
        sort: filters.sort,
        viewerId: studentId(req),
      }),
    ]);
    // Quick Reorder depends on who is asking: never let a shared cache keep it.
    if (filters.sort === 'quick-reorder') res.set('Cache-Control', 'private, no-store');
    res.json({
      outlet: toOutletSummary(outlet),
      categories: categories.map(toCategory),
      items: result.items,
      total: result.total,
      sort: result.sort,
      quickReorder: result.quickReorder,
      popularWindowDays: result.popularWindowDays,
    });
  });

  return router;
}
