import type { Database } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { normaliseEmail } from '../../lib/email.js';
import { recordAudit, type AuditActor } from '../../lib/audit.js';
import type { Role } from '../../generated/prisma/enums.js';
import type { Allowlists } from '../auth/provisioning.service.js';
import { deleteAllSessionsForUser } from '../auth/session.service.js';

/**
 * Roles that may be granted or revoked via the admin API.
 * STUDENT is excluded: it is the default given at signup and must never be
 * revoked through the normal role management flow (it would lock the user out).
 */
export type GrantableRole = Exclude<Role, 'STUDENT'>;

/** Persona roles: granted by admin only, no allowlist restriction. */
const PERSONA_ROLES = new Set<GrantableRole>(['FACULTY', 'STAFF', 'EXECUTIVE', 'GUEST']);

export interface RoleChangeResult {
  userId: string;
  role: GrantableRole;
  changed: boolean;
  sessionsEnded?: number;
}

/**
 * Grants a privileged role to an existing account.
 *
 * Rules (approved decision Q4):
 *  - The account must exist (the person signs in once first) and be active.
 *  - The provider must have verified the account's email.
 *  - MANAGER / POS may only go to emails on the matching allowlist — the list
 *    is a ceiling, not an automatic grant.
 *  - ADMIN is never granted through allowlists; only via this operation.
 */
export async function grantRole(
  db: Database,
  params: { email: string; role: GrantableRole; actor: AuditActor; lists: Allowlists },
): Promise<RoleChangeResult> {
  const email = normaliseEmail(params.email);

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, include: { roles: true } });
    if (!user) {
      throw new AppError(
        404,
        'USER_NOT_FOUND',
        `No account for ${email}. The person must sign in to CampusCart once first.`,
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(409, 'ACCOUNT_SUSPENDED', 'Cannot grant roles to a suspended account.');
    }
    if (!user.emailVerified) {
      throw new AppError(409, 'EMAIL_NOT_VERIFIED', 'Privileged roles need a verified email.');
    }
    // Persona roles (FACULTY, STAFF, EXECUTIVE, GUEST) are admin-granted only; no allowlist.
    if (!PERSONA_ROLES.has(params.role)) {
      if (params.role === 'MANAGER' && !params.lists.MANAGER_ALLOWED_EMAILS.includes(email)) {
        throw new AppError(409, 'NOT_ALLOWLISTED', `${email} is not in MANAGER_ALLOWED_EMAILS.`);
      }
      if (params.role === 'POS' && !params.lists.POS_ALLOWED_EMAILS.includes(email)) {
        throw new AppError(409, 'NOT_ALLOWLISTED', `${email} is not in POS_ALLOWED_EMAILS.`);
      }
    }

    const existing = user.roles.find((r) => r.role === params.role);
    if (existing && !existing.revokedAt) {
      return { userId: user.id, role: params.role, changed: false };
    }

    const grantedVia = params.actor.type === 'CLI' ? 'CLI' : 'ADMIN';
    if (existing) {
      await tx.userRole.update({
        where: { id: existing.id },
        data: {
          revokedAt: null,
          revokedById: null,
          revokeReason: null,
          grantedVia,
          grantedById: params.actor.userId ?? null,
        },
      });
    } else {
      await tx.userRole.create({
        data: {
          userId: user.id,
          role: params.role,
          grantedVia,
          grantedById: params.actor.userId ?? null,
        },
      });
    }

    await recordAudit(tx, {
      actor: params.actor,
      action: 'ROLE_GRANTED',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: params.role, via: grantedVia },
    });
    return { userId: user.id, role: params.role, changed: true };
  });
}

/**
 * Revokes a privileged role and signs the user out everywhere so every
 * device re-authenticates with the reduced permissions.
 * Live connections are closed straight away when revoked through the admin API,
 * and within a minute when revoked through the CLI (periodic session re-check).
 */
export async function revokeRole(
  db: Database,
  params: { email: string; role: GrantableRole; actor: AuditActor; reason: string },
): Promise<RoleChangeResult> {
  const email = normaliseEmail(params.email);
  const reason = params.reason.trim();
  if (reason.length < 3) {
    throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to revoke a role.');
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, include: { roles: true } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', `No account for ${email}.`);

    const existing = user.roles.find((r) => r.role === params.role && !r.revokedAt);
    if (!existing) return { userId: user.id, role: params.role, changed: false };

    if (params.role === 'ADMIN') {
      const activeAdmins = await tx.userRole.count({
        where: { role: 'ADMIN', revokedAt: null, user: { status: 'ACTIVE' } },
      });
      if (activeAdmins <= 1) {
        throw new AppError(409, 'LAST_ADMIN', 'Cannot revoke the last active administrator.');
      }
    }

    await tx.userRole.update({
      where: { id: existing.id },
      data: {
        revokedAt: new Date(),
        revokedById: params.actor.userId ?? null,
        revokeReason: reason,
      },
    });
    const sessionsEnded = await deleteAllSessionsForUser(tx, user.id);

    await recordAudit(tx, {
      actor: params.actor,
      action: 'ROLE_REVOKED',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: params.role, reason, sessionsEnded },
    });
    return { userId: user.id, role: params.role, changed: true, sessionsEnded };
  });
}
