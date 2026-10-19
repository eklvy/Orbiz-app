import type { CampusLocation, MenuCategory, MenuItem, Outlet } from '../../generated/prisma/client.js';
import { inStock, stockStatus } from '../inventory/stock.js';

export function toOutletSummary(outlet: Outlet) {
  return {
    id: outlet.id,
    slug: outlet.slug,
    name: outlet.name,
    description: outlet.description,
    location: outlet.location,
    imageUrl: outlet.imageUrl,
    status: outlet.status,
    /** Only OPEN outlets accept orders (enforced again at checkout). */
    acceptingOrders: outlet.status === 'OPEN' && outlet.isActive,
    isSample: outlet.isSample,
    // ─── Outlet intelligence (manually maintained, never auto-computed) ───────
    crowdLevel: outlet.crowdLevel,
    queueLength: outlet.queueLength,
    availableSeats: outlet.availableSeats,
    outletRating: outlet.outletRating,
    specialtyItems: outlet.specialtyItems,
    intelligenceUpdatedAt: outlet.intelligenceUpdatedAt?.toISOString() ?? null,
    // ─── Map coordinates ─────────────────────────────────────────────────────
    latitude: outlet.latitude,
    longitude: outlet.longitude,
  };
}

/** Staff/admin view also shows whether the outlet is archived. */
export function toOutletAdmin(outlet: Outlet) {
  return { ...toOutletSummary(outlet), isActive: outlet.isActive };
}

export function toCategory(category: MenuCategory) {
  return { id: category.id, name: category.name, sortOrder: category.sortOrder };
}

export function toCategoryAdmin(category: MenuCategory) {
  return { ...toCategory(category), isActive: category.isActive };
}

export function toMenuItem(item: MenuItem) {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    pricePaise: item.pricePaise,
    dietary: item.dietary,
    spiceLevel: item.spiceLevel,
    /** Can be ordered right now: not marked sold out and, if counted, units left. */
    isAvailable: inStock(item),
    /** AVAILABLE, LOW_STOCK (still orderable) or SOLD_OUT. Quantities are never shown to students. */
    stockStatus: stockStatus(item),
    imageUrl: item.imageUrl,
    nutrition: {
      calories: item.calories,
      protein: item.protein,
      carbohydrates: item.carbohydrates,
      fat: item.fat,
      allergens: item.allergens,
    },
  };
}

export function toCampusLocation(loc: CampusLocation) {
  return {
    id: loc.id,
    slug: loc.slug,
    name: loc.name,
    category: loc.category,
    latitude: loc.latitude,
    longitude: loc.longitude,
    description: loc.description,
  };
}

export function toMenuItemAdmin(item: MenuItem) {
  return {
    ...toMenuItem(item),
    isActive: item.isActive,
    sortOrder: item.sortOrder,
    /** The staff "sold out" switch (an override that stays until staff restore it). */
    soldOutManually: !item.isAvailable,
    fulfillmentType: item.fulfillmentType,
    trackInventory: item.trackInventory,
    stockQuantity: item.stockQuantity,
    lowStockThreshold: item.lowStockThreshold,
    stockUpdatedAt: item.stockUpdatedAt,
  };
}
