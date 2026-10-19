-- AlterEnum: add REDEEMED_REWARD to LoyaltyTransactionType.
ALTER TYPE "LoyaltyTransactionType" ADD VALUE 'REDEEMED_REWARD';

-- CreateTable: rewards catalog.
CREATE TABLE "RewardCatalog" (
    "id"            UUID          NOT NULL,
    "name"          TEXT          NOT NULL,
    "description"   TEXT          NOT NULL DEFAULT '',
    "pointCost"     INTEGER       NOT NULL,
    "isActive"      BOOLEAN       NOT NULL DEFAULT true,
    "voucherPrefix" TEXT,
    "totalStock"    INTEGER,
    "redeemedCount" INTEGER       NOT NULL DEFAULT 0,
    "validFrom"     TIMESTAMP(3),
    "validUntil"    TIMESTAMP(3),
    "isSample"      BOOLEAN       NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "RewardCatalog_pkey"              PRIMARY KEY ("id"),
    CONSTRAINT "RewardCatalog_pointCost_check"   CHECK ("pointCost" >= 1),
    CONSTRAINT "RewardCatalog_totalStock_check"  CHECK ("totalStock" IS NULL OR "totalStock" >= 1),
    CONSTRAINT "RewardCatalog_redeemedCount_check" CHECK ("redeemedCount" >= 0)
);

-- CreateTable: one student's claim of a reward.
CREATE TABLE "RewardRedemption" (
    "id"           UUID          NOT NULL,
    "userId"       UUID          NOT NULL,
    "rewardId"     UUID          NOT NULL,
    "loyaltyTxId"  UUID          NOT NULL,
    "voucherCode"  TEXT,
    "redeemedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardRedemption_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RewardRedemption"
    ADD CONSTRAINT "RewardRedemption_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RewardRedemption"
    ADD CONSTRAINT "RewardRedemption_rewardId_fkey"
    FOREIGN KEY ("rewardId") REFERENCES "RewardCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RewardRedemption"
    ADD CONSTRAINT "RewardRedemption_loyaltyTxId_fkey"
    FOREIGN KEY ("loyaltyTxId") REFERENCES "LoyaltyTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "RewardRedemption_loyaltyTxId_key"  ON "RewardRedemption"("loyaltyTxId");
CREATE UNIQUE INDEX "RewardRedemption_voucherCode_key"  ON "RewardRedemption"("voucherCode");

CREATE INDEX "RewardCatalog_isActive_validFrom_validUntil_idx"
    ON "RewardCatalog"("isActive", "validFrom", "validUntil");

CREATE INDEX "RewardRedemption_userId_createdAt_idx"   ON "RewardRedemption"("userId", "createdAt");
CREATE INDEX "RewardRedemption_rewardId_createdAt_idx" ON "RewardRedemption"("rewardId", "createdAt");
