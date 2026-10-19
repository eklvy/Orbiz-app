-- AlterTable: add optional nutrition fields and allergens to MenuItem.
-- All numeric columns are nullable so existing rows stay valid without a backfill.
-- allergens is a non-null text array; existing rows default to an empty array.
ALTER TABLE "MenuItem"
  ADD COLUMN "calories"      DOUBLE PRECISION,
  ADD COLUMN "protein"       DOUBLE PRECISION,
  ADD COLUMN "carbohydrates" DOUBLE PRECISION,
  ADD COLUMN "fat"           DOUBLE PRECISION,
  ADD COLUMN "allergens"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
