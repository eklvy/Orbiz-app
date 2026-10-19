import type { Database, DbClient } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TableStatus } from '../../generated/prisma/enums.js';

/*
 * Seat availability — DiningTable CRUD and manual occupancy updates.
 *
 * IMPORTANT: All occupancy figures are MANUALLY set by staff.
 * There is no camera, IoT sensor, or automatic detection of any kind.
 * The occupancy field reflects what a staff member last reported, not
 * a live headcount.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTableInput {
  label: string;
  capacity: number;
  notes?: string;
}

export interface UpdateTableInput {
  label?: string;
  capacity?: number;
  notes?: string;
  isActive?: boolean;
}

export interface UpdateOccupancyInput {
  occupancy: number;
  status: TableStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function requireTable(tx: DbClient, outletId: string, tableId: string) {
  const table = await tx.diningTable.findFirst({ where: { id: tableId, outletId } });
  if (!table) throw notFound('Table not found');
  return table;
}

// ─── Public queries ───────────────────────────────────────────────────────────

/** Returns active tables for an outlet — visible to anyone who can see the outlet. */
export async function listPublicTables(db: Database, outletId: string) {
  const tables = await db.diningTable.findMany({
    where: { outletId, isActive: true },
    orderBy: [{ label: 'asc' }],
    select: {
      id: true,
      label: true,
      capacity: true,
      occupancy: true,
      status: true,
      occupancyUpdatedAt: true,
    },
  });
  return tables.map((t) => ({
    id: t.id,
    label: t.label,
    capacity: t.capacity,
    occupancy: t.occupancy,
    status: t.status,
    /** Null means staff have never reported occupancy for this table. */
    occupancyUpdatedAt: t.occupancyUpdatedAt?.toISOString() ?? null,
    /** Reminder that these figures are manually entered by staff. */
    dataSource: 'MANUAL' as const,
  }));
}

// ─── Staff queries ────────────────────────────────────────────────────────────

/** Returns all tables for an outlet (including inactive) for staff views. */
export async function listStaffTables(db: Database, outletId: string) {
  const tables = await db.diningTable.findMany({
    where: { outletId },
    orderBy: [{ isActive: 'desc' }, { label: 'asc' }],
  });
  return tables.map(toStaffTable);
}

function toStaffTable(t: {
  id: string;
  label: string;
  capacity: number;
  occupancy: number;
  status: TableStatus;
  notes: string;
  isActive: boolean;
  occupancyUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    label: t.label,
    capacity: t.capacity,
    occupancy: t.occupancy,
    status: t.status,
    notes: t.notes,
    isActive: t.isActive,
    occupancyUpdatedAt: t.occupancyUpdatedAt?.toISOString() ?? null,
    dataSource: 'MANUAL' as const,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// ─── Staff mutations ──────────────────────────────────────────────────────────

export async function createTable(
  db: Database,
  outletId: string,
  actorId: string,
  input: CreateTableInput,
) {
  const existing = await db.diningTable.findFirst({
    where: { outletId, label: input.label },
    select: { id: true },
  });
  if (existing) throw new AppError(409, 'DUPLICATE_LABEL', 'A table with this label already exists at this outlet.');

  const table = await db.$transaction(async (tx) => {
    const created = await tx.diningTable.create({
      data: {
        outletId,
        label: input.label,
        capacity: input.capacity,
        notes: input.notes ?? '',
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: actorId },
      action: 'TABLE_CREATED',
      entityType: 'DiningTable',
      entityId: created.id,
      metadata: { label: created.label, capacity: created.capacity },
    });
    return created;
  });
  return toStaffTable(table);
}

export async function updateTable(
  db: Database,
  outletId: string,
  tableId: string,
  actorId: string,
  input: UpdateTableInput,
) {
  await requireTable(db, outletId, tableId);

  // If capacity is being reduced, ensure new capacity >= current occupancy.
  if (input.capacity !== undefined) {
    const current = await db.diningTable.findUnique({
      where: { id: tableId },
      select: { occupancy: true },
    });
    if (current && current.occupancy > input.capacity) {
      throw new AppError(
        409,
        'CAPACITY_BELOW_OCCUPANCY',
        `Cannot set capacity to ${input.capacity} — ${current.occupancy} guests are currently reported as seated.`,
        { currentOccupancy: current.occupancy },
      );
    }
  }

  const table = await db.$transaction(async (tx) => {
    const updated = await tx.diningTable.update({
      where: { id: tableId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: actorId },
      action: 'TABLE_UPDATED',
      entityType: 'DiningTable',
      entityId: tableId,
      metadata: input as Prisma.InputJsonValue,
    });
    return updated;
  });
  return toStaffTable(table);
}

/**
 * Updates the occupancy count and status for a table.
 *
 * This is a MANUAL update — a staff member is telling the system how many
 * guests are currently seated. No automatic detection exists.
 */
export async function updateOccupancy(
  db: Database,
  outletId: string,
  tableId: string,
  actorId: string,
  input: UpdateOccupancyInput,
) {
  const table = await requireTable(db, outletId, tableId);
  if (!table.isActive) throw new AppError(409, 'TABLE_INACTIVE', 'This table is deactivated.');

  if (input.occupancy > table.capacity) {
    throw new AppError(
      409,
      'OCCUPANCY_EXCEEDS_CAPACITY',
      `Occupancy (${input.occupancy}) cannot exceed the table's capacity (${table.capacity}).`,
      { capacity: table.capacity },
    );
  }

  // AVAILABLE tables must have occupancy = 0; OCCUPIED must have occupancy >= 1.
  if (input.status === 'AVAILABLE' && input.occupancy > 0) {
    throw new AppError(
      400,
      'OCCUPANCY_STATUS_MISMATCH',
      'An available table must have 0 occupancy. Use status OCCUPIED when guests are seated.',
    );
  }
  if (input.status === 'OCCUPIED' && input.occupancy === 0) {
    throw new AppError(
      400,
      'OCCUPANCY_STATUS_MISMATCH',
      'An occupied table must have at least 1 guest. Use status AVAILABLE when the table is empty.',
    );
  }

  const updated = await db.diningTable.update({
    where: { id: tableId },
    data: {
      occupancy: input.occupancy,
      status: input.status,
      occupancyUpdatedAt: new Date(),
    },
  });
  return toStaffTable(updated);
}

export async function deactivateTable(
  db: Database,
  outletId: string,
  tableId: string,
  actorId: string,
) {
  await requireTable(db, outletId, tableId);
  const table = await db.$transaction(async (tx) => {
    const updated = await tx.diningTable.update({
      where: { id: tableId },
      data: { isActive: false },
    });
    await recordAudit(tx, {
      actor: { type: 'USER', userId: actorId },
      action: 'TABLE_DEACTIVATED',
      entityType: 'DiningTable',
      entityId: tableId,
      metadata: {},
    });
    return updated;
  });
  return toStaffTable(table);
}
