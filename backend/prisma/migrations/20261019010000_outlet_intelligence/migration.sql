-- CreateEnum: crowd level for Outlet intelligence
CREATE TYPE "CrowdLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'VERY_HIGH');

-- AlterTable: add manually-updated intelligence fields to Outlet.
-- All columns are nullable or have safe defaults so existing rows are untouched.
ALTER TABLE "Outlet"
  ADD COLUMN "crowdLevel"            "CrowdLevel",
  ADD COLUMN "queueLength"           INTEGER,
  ADD COLUMN "availableSeats"        INTEGER,
  ADD COLUMN "outletRating"          DOUBLE PRECISION,
  ADD COLUMN "specialtyItems"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "intelligenceUpdatedAt" TIMESTAMP(3);
