-- Add photo and helpful-count to FoodReview; add ReviewLike model

ALTER TABLE "FoodReview"
  ADD COLUMN "photoUrl"     TEXT,
  ADD COLUMN "helpfulCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ReviewLike" (
    "id"        UUID         NOT NULL,
    "reviewId"  UUID         NOT NULL,
    "userId"    UUID         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewLike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewLike_reviewId_userId_key" ON "ReviewLike"("reviewId", "userId");
CREATE INDEX "ReviewLike_reviewId_idx" ON "ReviewLike"("reviewId");
CREATE INDEX "FoodReview_status_helpfulCount_createdAt_idx"
    ON "FoodReview"("status", "helpfulCount", "createdAt");

ALTER TABLE "ReviewLike"
  ADD CONSTRAINT "ReviewLike_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "FoodReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewLike"
  ADD CONSTRAINT "ReviewLike_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
