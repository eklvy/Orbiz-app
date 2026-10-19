-- Ties all orders from a single multi-outlet checkout together.
-- Null for orders placed before this migration (single-outlet legacy orders).
ALTER TABLE "Order" ADD COLUMN "batchKey" TEXT;

CREATE INDEX "Order_userId_batchKey_idx" ON "Order"("userId", "batchKey");
