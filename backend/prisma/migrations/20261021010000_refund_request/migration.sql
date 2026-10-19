-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PROCESSED');

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id"                UUID        NOT NULL,
    "orderId"           UUID        NOT NULL,
    "requestedByUserId" UUID        NOT NULL,
    "amountPaise"       INTEGER     NOT NULL,
    "reason"            TEXT        NOT NULL,
    "status"            "RefundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId"   UUID,
    "decidedAt"         TIMESTAMP(3),
    "decisionNote"      TEXT,
    "processedAt"       TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "RefundRequest_amountPaise_check" CHECK ("amountPaise" > 0)
);

-- CreateIndex
CREATE INDEX "RefundRequest_orderId_idx"            ON "RefundRequest"("orderId");
CREATE INDEX "RefundRequest_status_createdAt_idx"   ON "RefundRequest"("status", "createdAt");
CREATE INDEX "RefundRequest_requestedByUserId_idx"  ON "RefundRequest"("requestedByUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundRequest"
    ADD CONSTRAINT "RefundRequest_decidedByUserId_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
