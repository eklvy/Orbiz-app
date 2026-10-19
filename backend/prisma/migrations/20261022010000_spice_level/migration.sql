-- Add SpiceLevel enum and spiceLevel column to MenuItem

CREATE TYPE "SpiceLevel" AS ENUM ('MILD', 'MEDIUM', 'HOT');

ALTER TABLE "MenuItem" ADD COLUMN "spiceLevel" "SpiceLevel";
