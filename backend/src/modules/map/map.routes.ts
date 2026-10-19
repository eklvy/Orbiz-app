import { Router } from 'express';
import type { Database } from '../../lib/prisma.js';
import { toCampusLocation } from '../outlets/outlets.serializer.js';

/**
 * GET /api/v1/map
 *
 * Public endpoint returning all active outlets with map coordinates, plus
 * all active campus locations. Outlets without coordinates are included with
 * latitude/longitude set to null so the frontend can list them even when they
 * cannot be pinned on the map.
 */
export function campusMapRouter(db: Database) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const [outlets, locations] = await Promise.all([
      db.outlet.findMany({
        where: { isActive: true },
        select: {
          id: true,
          slug: true,
          name: true,
          location: true,
          description: true,
          imageUrl: true,
          status: true,
          crowdLevel: true,
          latitude: true,
          longitude: true,
          specialtyItems: true,
          outletRating: true,
        },
        orderBy: { name: 'asc' },
      }),
      db.campusLocation.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({
      outlets: outlets.map((o) => ({
        id: o.id,
        slug: o.slug,
        name: o.name,
        location: o.location,
        description: o.description,
        imageUrl: o.imageUrl,
        status: o.status,
        crowdLevel: o.crowdLevel,
        outletRating: o.outletRating,
        specialtyItems: o.specialtyItems,
        latitude: o.latitude,
        longitude: o.longitude,
      })),
      locations: locations.map(toCampusLocation),
    });
  });

  return router;
}
