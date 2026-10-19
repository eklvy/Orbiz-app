import { prisma } from '../lib/prisma.js';
import type { Dietary, OutletStatus, SpiceLevel } from '../generated/prisma/enums.js';

/** Test-only builders. Each call creates rows in the test database. */

let counter = 0;
const next = () => ++counter;

export async function makeOutlet(
  overrides: { name?: string; status?: OutletStatus; isActive?: boolean } = {},
) {
  const n = next();
  return prisma.outlet.create({
    data: {
      slug: `outlet-${n}`,
      name: overrides.name ?? `Outlet ${n}`,
      status: overrides.status ?? 'OPEN',
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function makeCategory(outletId: string, name = `Category ${next()}`, sortOrder = 0) {
  return prisma.menuCategory.create({ data: { outletId, name, sortOrder } });
}

export async function makeItem(
  outletId: string,
  categoryId: string,
  overrides: {
    name?: string;
    pricePaise?: number;
    dietary?: Dietary | null;
    spiceLevel?: SpiceLevel | null;
    isAvailable?: boolean;
    isActive?: boolean;
    description?: string;
  } = {},
) {
  return prisma.menuItem.create({
    data: {
      outletId,
      categoryId,
      name: overrides.name ?? `Item ${next()}`,
      description: overrides.description ?? '',
      pricePaise: overrides.pricePaise ?? 5000,
      dietary: overrides.dietary === undefined ? 'VEG' : overrides.dietary,
      spiceLevel: overrides.spiceLevel ?? null,
      isAvailable: overrides.isAvailable ?? true,
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function assign(email: string, outletId: string, role: 'MANAGER' | 'POS') {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return prisma.staffAssignment.create({ data: { userId: user.id, outletId, role } });
}
