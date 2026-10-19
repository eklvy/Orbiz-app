import { z } from 'zod';

export const uuidParam = z.uuid();

const name = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const outletStatusSchema = z.enum(['OPEN', 'PAUSED', 'CLOSED']);
export const dietarySchema = z.enum(['VEG', 'NON_VEG', 'EGG']);
export const spiceLevelSchema = z.enum(['MILD', 'MEDIUM', 'HOT']);
export const staffRoleSchema = z.enum(['MANAGER', 'POS']);

/** ₹1 – ₹10,000, as integer paise. Floats are rejected rather than rounded. */
export const pricePaiseSchema = z
  .number()
  .int('Price must be a whole number of paise')
  .min(100, 'Minimum price is ₹1')
  .max(1_000_000, 'Maximum price is ₹10,000');

const sortOrder = z.number().int().min(0).max(10_000);

/** Free-text search: trimmed, capped, empty means "no filter". */
const searchText = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const outletListQuery = z.object({ q: searchText });

/** popular | price-asc | price-desc | quick-reorder | highest-rated (docs/menu-search.md). */
export const menuSort = z
  .enum(['popular', 'price-asc', 'price-desc', 'quick-reorder', 'highest-rated', 'rating'])
  // "rating" was the first name for highest-rated; still accepted.
  .transform((v) => (v === 'rating' ? 'highest-rated' : v))
  .optional();

const yes = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

export const menuQuery = z.object({
  q: searchText,
  category: uuidParam.optional(),
  dietary: dietarySchema.optional(),
  spiceLevel: spiceLevelSchema.optional(),
  sort: menuSort,
  /** Only dishes that can be ordered right now. */
  inStock: yes,
});

/** GET /menu — the campus-wide menu, paged. */
export const campusMenuQuery = menuQuery.extend({
  outletId: uuidParam.optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
});

export const outletStatusBody = z.object({ status: outletStatusSchema }).strict();

export const createCategoryBody = z
  .object({ name: name(40), sortOrder: sortOrder.optional() })
  .strict();

export const updateCategoryBody = z
  .object({ name: name(40), sortOrder, isActive: z.boolean() })
  .partial()
  .strict();

/** Non-negative float for nutrition values (kcal or grams). */
const nutritionValue = z.number().min(0, 'Must be 0 or greater');
/** Up to 20 allergen strings, each trimmed and non-empty, max 50 chars. */
const allergensSchema = z.array(z.string().trim().min(1).max(50)).max(20);

export const createItemBody = z
  .object({
    categoryId: uuidParam,
    name: name(80),
    description: z.string().trim().max(300).default(''),
    pricePaise: pricePaiseSchema,
    dietary: dietarySchema.nullable().optional(),
    spiceLevel: spiceLevelSchema.nullable().optional(),
    isAvailable: z.boolean().optional(),
    /** PACKAGED or HANDMADE (no-show policy). Never inferred from the name. */
    fulfillmentType: z.enum(['PACKAGED', 'HANDMADE']).nullable().optional(),
    sortOrder: sortOrder.optional(),
    imageUrl: z.url().max(1000).nullable().optional(),
    calories: nutritionValue.nullable().optional(),
    protein: nutritionValue.nullable().optional(),
    carbohydrates: nutritionValue.nullable().optional(),
    fat: nutritionValue.nullable().optional(),
    allergens: allergensSchema.optional(),
  })
  .strict();

export const updateItemBody = z
  .object({
    categoryId: uuidParam,
    name: name(80),
    description: z.string().trim().max(300),
    pricePaise: pricePaiseSchema,
    dietary: dietarySchema.nullable(),
    spiceLevel: spiceLevelSchema.nullable(),
    isAvailable: z.boolean(),
    fulfillmentType: z.enum(['PACKAGED', 'HANDMADE']).nullable(),
    isActive: z.boolean(),
    sortOrder,
    imageUrl: z.url().max(1000).nullable(),
    calories: nutritionValue.nullable(),
    protein: nutritionValue.nullable(),
    carbohydrates: nutritionValue.nullable(),
    fat: nutritionValue.nullable(),
    allergens: allergensSchema,
  })
  .partial()
  .strict();

export const availabilityBody = z.object({ isAvailable: z.boolean() }).strict();

export const createOutletBody = z
  .object({
    name: name(60),
    description: z.string().trim().max(300).default(''),
    location: z.string().trim().max(120).default(''),
    status: outletStatusSchema.optional(),
    imageUrl: z.url().max(1000).nullable().optional(),
  })
  .strict();

export const updateOutletBody = z
  .object({
    name: name(60),
    description: z.string().trim().max(300),
    location: z.string().trim().max(120),
    status: outletStatusSchema,
    isActive: z.boolean(),
    imageUrl: z.url().max(1000).nullable(),
  })
  .partial()
  .strict();

export const assignStaffBody = z.object({ email: z.email(), role: staffRoleSchema }).strict();

// ─── Outlet intelligence ──────────────────────────────────────────────────────

export const crowdLevelSchema = z.enum(['LOW', 'MODERATE', 'HIGH', 'VERY_HIGH']);

const specialtyItem = z.string().trim().min(1).max(80);

/** Manager updates crowd level, queue, seats, rating and signature dishes. */
export const updateIntelligenceBody = z
  .object({
    crowdLevel: crowdLevelSchema.nullable(),
    /** Estimated queue length (≥ 0). null = unknown / clear it. */
    queueLength: z.number().int().min(0).nullable(),
    /** Available dine-in seats (≥ 0). null = unknown / clear it. */
    availableSeats: z.number().int().min(0).nullable(),
    /** Manager-maintained star rating 1.0–5.0. null = clear it. */
    outletRating: z.number().min(1).max(5).nullable(),
    /** Up to 10 signature dish names. */
    specialtyItems: z.array(specialtyItem).max(10),
  })
  .partial()
  .strict();

// ─── Map coordinates ──────────────────────────────────────────────────────────

export const updateCoordinatesBody = z
  .object({
    /** WGS-84 latitude −90 to 90, or null to clear. */
    latitude: z.number().min(-90).max(90).nullable(),
    /** WGS-84 longitude −180 to 180, or null to clear. */
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .strict();

// ─── Campus locations ─────────────────────────────────────────────────────────

const locationName = (max: number) => z.string().trim().min(1, 'Required').max(max);
const locationSlug = z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits and hyphens only');

export const createCampusLocationBody = z
  .object({
    slug: locationSlug,
    name: locationName(120),
    category: locationName(40),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    description: z.string().trim().max(300).default(''),
  })
  .strict();

export const updateCampusLocationBody = z
  .object({
    name: locationName(120),
    category: locationName(40),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    description: z.string().trim().max(300),
    isActive: z.boolean(),
  })
  .partial()
  .strict();
