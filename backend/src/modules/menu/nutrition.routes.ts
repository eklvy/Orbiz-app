import { Router } from 'express';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { uuidParam } from '../outlets/outlets.schema.js';

/**
 * GET /api/v1/menu-items/:itemId/nutrition
 * Public endpoint returning full nutrition details for one active menu item.
 * Returns 404 for unknown or deactivated items.
 */
export function menuItemNutritionRouter(db: Database) {
  const router = Router();

  router.get('/:itemId/nutrition', async (req, res) => {
    const parsed = uuidParam.safeParse(req.params.itemId);
    if (!parsed.success) throw notFound('Menu item not found');

    const item = await db.menuItem.findFirst({
      where: { id: parsed.data, isActive: true },
      select: {
        id: true,
        name: true,
        calories: true,
        protein: true,
        carbohydrates: true,
        fat: true,
        allergens: true,
      },
    });
    if (!item) throw notFound('Menu item not found');

    res.json({
      id: item.id,
      name: item.name,
      nutrition: {
        calories: item.calories,
        protein: item.protein,
        carbohydrates: item.carbohydrates,
        fat: item.fat,
        allergens: item.allergens,
      },
    });
  });

  return router;
}
