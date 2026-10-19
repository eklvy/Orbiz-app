import { Router, type Request } from 'express';
import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { normaliseEmail } from '../../lib/email.js';
import { slugify } from '../../lib/slug.js';
import { requireRole } from '../../middleware/auth.js';
import {
  assignStaffBody,
  createCampusLocationBody,
  createOutletBody,
  updateCampusLocationBody,
  updateCoordinatesBody,
  updateOutletBody,
  uuidParam,
} from './outlets.schema.js';
import { toCampusLocation, toOutletAdmin } from './outlets.serializer.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';

function idParam(req: Request, name: string): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

const actorOf = (req: Request) => ({ type: 'USER' as const, userId: req.auth!.user.id });

/** Outlet administration and staff assignment. Administrators only; every change is audited. */
export function adminOutletsRouter(db: Database, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('ADMIN'));

  async function uniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const taken = await db.outlet.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
  }

  router.get('/', async (_req, res) => {
    const outlets = await db.outlet.findMany({ orderBy: { name: 'asc' } });
    res.json({ outlets: outlets.map(toOutletAdmin) });
  });

  router.post('/', async (req, res) => {
    const body = createOutletBody.parse(req.body);
    const slug = await uniqueSlug(body.name);
    const outlet = await db.$transaction(async (tx) => {
      const created = await tx.outlet.create({ data: { ...body, slug } });
      await recordAudit(tx, {
        actor: actorOf(req),
        action: 'OUTLET_CREATED',
        entityType: 'Outlet',
        entityId: created.id,
        metadata: { name: created.name, slug },
      });
      return created;
    });
    res.status(201).json({ outlet: toOutletAdmin(outlet) });
  });

  router.patch('/:outletId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = updateOutletBody.parse(req.body);
    const outlet = await db.$transaction(async (tx) => {
      const before = await tx.outlet.findUnique({ where: { id: outletId } });
      if (!before) throw notFound('Outlet not found');
      const after = await tx.outlet.update({ where: { id: outletId }, data: body });
      await recordAudit(tx, {
        actor: actorOf(req),
        action: 'OUTLET_UPDATED',
        entityType: 'Outlet',
        entityId: outletId,
        metadata: { changes: body },
      });
      return after;
    });
    if (body.isActive !== undefined) {
      const staff = await db.staffAssignment.findMany({
        where: { outletId },
        select: { userId: true },
      });
      for (const userId of new Set(staff.map((a) => a.userId))) realtime.staffAccessChanged(userId);
    }
    res.json({ outlet: toOutletAdmin(outlet) });
  });

  router.get('/:outletId/staff', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const staff = await db.staffAssignment.findMany({
      where: { outletId },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      staff: staff.map((s) => ({ id: s.id, role: s.role, user: s.user, createdAt: s.createdAt })),
    });
  });

  /** Assign a user who already holds the MANAGER or POS role to this outlet. */
  router.post('/:outletId/staff', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = assignStaffBody.parse(req.body);
    const email = normaliseEmail(body.email);

    const result = await db.$transaction(async (tx) => {
      const outlet = await tx.outlet.findUnique({ where: { id: outletId } });
      if (!outlet) throw notFound('Outlet not found');
      const user = await tx.user.findUnique({
        where: { email },
        include: { roles: { where: { role: body.role, revokedAt: null } } },
      });
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', `No account for ${email}.`);
      if (user.roles.length === 0) {
        throw new AppError(
          409,
          'ROLE_REQUIRED',
          `${email} does not hold the ${body.role} role. Grant the role first.`,
        );
      }

      const existing = await tx.staffAssignment.findUnique({
        where: { userId_outletId_role: { userId: user.id, outletId, role: body.role } },
      });
      if (existing) return { assignment: existing, created: false };

      const assignment = await tx.staffAssignment.create({
        data: { userId: user.id, outletId, role: body.role, createdById: req.auth!.user.id },
      });
      await recordAudit(tx, {
        actor: actorOf(req),
        action: 'STAFF_ASSIGNED',
        entityType: 'Outlet',
        entityId: outletId,
        metadata: { userId: user.id, email, role: body.role },
      });
      return { assignment, created: true };
    });

    if (result.created) realtime.staffAccessChanged(result.assignment.userId);
    res.status(result.created ? 201 : 200).json({
      assignment: { id: result.assignment.id, role: result.assignment.role, outletId },
    });
  });

  /** PATCH /:outletId/coordinates — admin sets or clears the outlet's map position. */
  router.patch('/:outletId/coordinates', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const body = updateCoordinatesBody.parse(req.body);
    const before = await db.outlet.findUnique({ where: { id: outletId } });
    if (!before) throw notFound('Outlet not found');
    const outlet = await db.$transaction(async (tx) => {
      const updated = await tx.outlet.update({ where: { id: outletId }, data: body });
      await recordAudit(tx, {
        actor: actorOf(req),
        action: 'OUTLET_COORDINATES_UPDATED',
        entityType: 'Outlet',
        entityId: outletId,
        metadata: { latitude: body.latitude, longitude: body.longitude },
      });
      return updated;
    });
    res.json({ outlet: toOutletAdmin(outlet) });
  });

  // ─── Campus locations CRUD ─────────────────────────────────────────────────

  router.get('/map/locations', async (_req, res) => {
    const locations = await db.campusLocation.findMany({ orderBy: { name: 'asc' } });
    res.json({ locations: locations.map(toCampusLocation) });
  });

  router.post('/map/locations', async (req, res) => {
    const body = createCampusLocationBody.parse(req.body);
    const existing = await db.campusLocation.findUnique({ where: { slug: body.slug } });
    if (existing) throw new AppError(409, 'DUPLICATE_SLUG', 'A location with this slug already exists.');
    const location = await db.campusLocation.create({ data: body });
    res.status(201).json({ location: toCampusLocation(location) });
  });

  router.patch('/map/locations/:locationId', async (req, res) => {
    const locationId = idParam(req, 'locationId');
    const existing = await db.campusLocation.findUnique({ where: { id: locationId } });
    if (!existing) throw notFound('Campus location not found');
    const body = updateCampusLocationBody.parse(req.body);
    const location = await db.campusLocation.update({ where: { id: locationId }, data: body });
    res.json({ location: toCampusLocation(location) });
  });

  router.delete('/map/locations/:locationId', async (req, res) => {
    const locationId = idParam(req, 'locationId');
    const existing = await db.campusLocation.findUnique({ where: { id: locationId } });
    if (!existing) throw notFound('Campus location not found');
    await db.campusLocation.delete({ where: { id: locationId } });
    res.status(204).end();
  });

  router.delete('/:outletId/staff/:assignmentId', async (req, res) => {
    const outletId = idParam(req, 'outletId');
    const assignmentId = idParam(req, 'assignmentId');
    const removedUserId = await db.$transaction(async (tx) => {
      const assignment = await tx.staffAssignment.findFirst({
        where: { id: assignmentId, outletId },
      });
      if (!assignment) throw notFound('Assignment not found');
      await tx.staffAssignment.delete({ where: { id: assignment.id } });
      await recordAudit(tx, {
        actor: actorOf(req),
        action: 'STAFF_UNASSIGNED',
        entityType: 'Outlet',
        entityId: outletId,
        metadata: { userId: assignment.userId, role: assignment.role },
      });
      return assignment.userId;
    });
    realtime.staffAccessChanged(removedUserId);
    res.status(204).end();
  });

  return router;
}
