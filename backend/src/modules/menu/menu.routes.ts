import { Router, type Request } from 'express';
import type { Database } from '../../lib/prisma.js';
import { campusMenuQuery } from '../outlets/outlets.schema.js';
import { searchMenu } from './menu-search.js';

/** The signed-in student, if any — Quick Reorder only ever reads this user's own orders. */
export const studentId = (req: Request) =>
  req.auth?.user.roles.includes('STUDENT') ? req.auth.user.id : undefined;

/**
 * /api/v1/menu — every visible dish on campus: search (dish, category or outlet name), filters
 * (outlet, category, dietary, in stock) and sorting, paged. Public; Quick Reorder needs sign-in.
 */
export function campusMenuRouter(db: Database) {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = campusMenuQuery.parse(req.query);
    const [result, outlets, categories] = await Promise.all([
      searchMenu(db, {
        outletId: query.outletId,
        categoryId: query.category,
        q: query.q,
        dietary: query.dietary,
        spiceLevel: query.spiceLevel,
        inStockOnly: query.inStock,
        sort: query.sort,
        viewerId: studentId(req),
        searchOutletNames: true,
        page: query.page,
        pageSize: query.pageSize,
      }),
      db.outlet.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      }),
      query.outletId
        ? db.menuCategory.findMany({
            where: { outletId: query.outletId, isActive: true },
            select: { id: true, name: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([]),
    ]);
    if (query.sort === 'quick-reorder') res.set('Cache-Control', 'private, no-store');
    res.json({ ...result, filters: { outlets, categories } });
  });

  return router;
}
