import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOutletRole } from '../../middleware/outlet-access.js';
import { uuidParam } from '../outlets/outlets.schema.js';
import {
  createTable,
  deactivateTable,
  listPublicTables,
  listStaffTables,
  updateOccupancy,
  updateTable,
} from './tables.service.js';

const tableStatusSchema = z.enum(['AVAILABLE', 'OCCUPIED', 'UNAVAILABLE']);

const createTableBody = z
  .object({
    label: z.string().trim().min(1, 'Required').max(80),
    capacity: z.number().int().min(1).max(500),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

const updateTableBody = z
  .object({
    label: z.string().trim().min(1, 'Required').max(80),
    capacity: z.number().int().min(1).max(500),
    notes: z.string().trim().max(300),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

const updateOccupancyBody = z
  .object({
    /** Manually entered count. MUST match the status (0 = AVAILABLE, ≥1 = OCCUPIED). */
    occupancy: z.number().int().min(0),
    status: tableStatusSchema,
  })
  .strict();

function idParam(req: Request, name: string) {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

// ─── Public: seat availability for an outlet ──────────────────────────────────

/**
 * GET /outlets/:slug/tables
 * Returns active tables with their manually-reported occupancy.
 * No authentication required — same access level as viewing the outlet menu.
 */
export function publicTablesRouter(db: Database) {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const outlet = await db.outlet.findUnique({
      where: { slug: (req.params as Record<string, string>).slug },
      select: { id: true, isActive: true },
    });
    if (!outlet || !outlet.isActive) throw notFound('Outlet not found');
    const tables = await listPublicTables(db, outlet.id);
    res.json({ tables });
  });

  return router;
}

// ─── Staff: full table management ────────────────────────────────────────────

/**
 * /staff/outlets/:outletId/tables
 * MANAGER can create/update/deactivate tables.
 * MANAGER or POS can read tables and update occupancy.
 */
export function staffTablesRouter(db: Database) {
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  const manager = requireOutletRole(db, 'MANAGER');
  const managerOrPos = requireOutletRole(db, 'MANAGER', 'POS');

  /** GET / — list all tables (including inactive) for this outlet. */
  router.get('/', managerOrPos, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const tables = await listStaffTables(db, outletId);
    res.json({ tables });
  });

  /** POST / — create a new table. MANAGER only. */
  router.post('/', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = createTableBody.parse(req.body);
    const table = await createTable(db, outletId, req.auth!.user.id, body);
    res.status(201).json({ table });
  });

  /** PATCH /:tableId — update table metadata. MANAGER only. */
  router.patch('/:tableId', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const tableId = idParam(req, 'tableId');
    const body = updateTableBody.parse(req.body);
    const table = await updateTable(db, outletId, tableId, req.auth!.user.id, body);
    res.json({ table });
  });

  /**
   * PATCH /:tableId/occupancy — manually update how many guests are seated.
   * MANAGER or POS — both roles can report current occupancy.
   *
   * NOTE: This is a MANUAL update only. Staff enter the current headcount;
   * there is no automatic detection.
   */
  router.patch('/:tableId/occupancy', managerOrPos, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const tableId = idParam(req, 'tableId');
    const body = updateOccupancyBody.parse(req.body);
    const table = await updateOccupancy(db, outletId, tableId, req.auth!.user.id, body);
    res.json({ table });
  });

  /** DELETE /:tableId — deactivate a table (soft delete). MANAGER only. */
  router.delete('/:tableId', manager, async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const tableId = idParam(req, 'tableId');
    await deactivateTable(db, outletId, tableId, req.auth!.user.id);
    res.status(204).end();
  });

  return router;
}
