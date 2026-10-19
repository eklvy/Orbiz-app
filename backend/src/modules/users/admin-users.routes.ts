import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { requireRole } from '../../middleware/auth.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { grantRole, revokeRole, type GrantableRole } from './roles.service.js';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(200).optional(),
});
const grantBody = z
  .object({ role: z.enum(['MANAGER', 'POS', 'ADMIN', 'FACULTY', 'STAFF', 'EXECUTIVE', 'GUEST']) })
  .strict();
const revokeBody = z
  .object({ reason: z.string().trim().min(3, 'Give a reason').max(200) })
  .strict();
const roleParam = z.enum(['MANAGER', 'POS', 'ADMIN', 'FACULTY', 'STAFF', 'EXECUTIVE', 'GUEST']);

function userIdParam(req: Request) {
  const parsed = z.uuid().safeParse(req.params.userId);
  if (!parsed.success) throw notFound('User not found');
  return parsed.data;
}

/** /api/v1/admin/users — accounts and their roles. Administrators only; every change is audited. */
export function adminUsersRouter(db: Database, config: Env, realtime: RealtimePublisher) {
  const router = Router();
  router.use(requireRole('ADMIN'));

  router.get('/', async (req, res) => {
    const { q, limit, cursor } = listQuery.parse(req.query);
    const rows = await db.user.findMany({
      where: q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {},
      include: {
        roles: { where: { revokedAt: null }, select: { role: true } },
        identities: { select: { provider: true } },
        staffAssignments: { include: { outlet: { select: { id: true, name: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const page = rows.slice(0, limit);
    res.json({
      users: page.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        emailVerified: u.emailVerified,
        status: u.status,
        signInMethod: u.identities[0]?.provider ?? 'GOOGLE',
        roles: u.roles.map((r) => r.role),
        // The allowlists are a ceiling (decision Q4): only these accounts may be granted the role.
        eligibleFor: {
          MANAGER: u.emailVerified && config.MANAGER_ALLOWED_EMAILS.includes(u.email),
          POS: u.emailVerified && config.POS_ALLOWED_EMAILS.includes(u.email),
          ADMIN: u.emailVerified,
        },
        assignments: u.staffAssignments.map((a) => ({ id: a.id, role: a.role, outlet: a.outlet })),
        createdAt: u.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  });

  router.post('/:userId/roles', async (req, res) => {
    const user = await db.user.findUnique({ where: { id: userIdParam(req) } });
    if (!user) throw notFound('User not found');
    const { role } = grantBody.parse(req.body);
    const result = await grantRole(db, {
      email: user.email,
      role,
      actor: { type: 'USER', userId: req.auth!.user.id },
      lists: config,
    });
    if (result.changed) realtime.staffAccessChanged(user.id);
    res.status(result.changed ? 201 : 200).json({ changed: result.changed });
  });

  router.post('/:userId/roles/:role/revoke', async (req, res) => {
    const user = await db.user.findUnique({ where: { id: userIdParam(req) } });
    if (!user) throw notFound('User not found');
    const role = roleParam.safeParse(req.params.role);
    if (!role.success) throw notFound('Role not found');
    const { reason } = revokeBody.parse(req.body);
    if (role.data === 'ADMIN' && user.id === req.auth!.user.id) {
      throw new AppError(
        409,
        'SELF_REVOKE',
        'You cannot remove your own administrator role. Ask another administrator.',
      );
    }
    const result = await revokeRole(db, {
      email: user.email,
      role: role.data as GrantableRole,
      actor: { type: 'USER', userId: req.auth!.user.id },
      reason,
    });
    // Revocation ended their sessions; close any live connections right away too.
    if (result.changed) realtime.endUser(user.id);
    res.json({ changed: result.changed, sessionsEnded: result.sessionsEnded ?? 0 });
  });

  return router;
}

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(60).optional(),
});

/** /api/v1/admin/audit-logs — the append-only record of sensitive actions. Read-only. */
export function adminAuditRouter(db: Database) {
  const router = Router();
  router.use(requireRole('ADMIN'));

  router.get('/actions', async (_req, res) => {
    const rows = await db.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });
    res.json({ actions: rows.map((r) => r.action) });
  });

  router.get('/', async (req, res) => {
    const { limit, cursor, action, entityType } = auditQuery.parse(req.query);
    const rows = await db.auditLog.findMany({
      where: { ...(action && { action }), ...(entityType && { entityType }) },
      include: { actor: { select: { id: true, email: true, displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const page = rows.slice(0, limit);
    res.json({
      entries: page.map((e) => ({
        id: e.id,
        actorType: e.actorType,
        actor: e.actor,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  });

  return router;
}
