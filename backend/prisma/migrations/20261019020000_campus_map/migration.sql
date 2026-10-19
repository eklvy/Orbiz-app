-- AlterTable: add WGS-84 coordinates to Outlet (nullable; admin-set).
ALTER TABLE "Outlet"
  ADD COLUMN "latitude"  DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION;

-- CreateTable: non-outlet campus points of interest for the map.
CREATE TABLE "CampusLocation" (
    "id"          UUID NOT NULL,
    "slug"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "latitude"    DOUBLE PRECISION NOT NULL,
    "longitude"   DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampusLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampusLocation_slug_key" ON "CampusLocation"("slug");
CREATE INDEX "CampusLocation_isActive_idx" ON "CampusLocation"("isActive");
