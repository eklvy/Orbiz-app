-- CreateTable: per-user optional monthly spending cap.
CREATE TABLE "SpendingBudget" (
    "id"         UUID          NOT NULL,
    "userId"     UUID          NOT NULL,
    "limitPaise" INTEGER       NOT NULL,
    "timezone"   TEXT          NOT NULL DEFAULT 'Asia/Kolkata',
    "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "SpendingBudget_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "SpendingBudget_limitPaise_check" CHECK ("limitPaise" >= 100)
);

-- CreateIndex: one budget per user.
CREATE UNIQUE INDEX "SpendingBudget_userId_key" ON "SpendingBudget"("userId");

-- AddForeignKey
ALTER TABLE "SpendingBudget"
    ADD CONSTRAINT "SpendingBudget_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
