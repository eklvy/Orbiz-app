-- CreateEnum: current occupancy status of a physical table.
-- Managed MANUALLY by staff — no camera or sensor data exists.
CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'UNAVAILABLE');

-- CreateEnum: lifecycle states for a table reservation.
CREATE TYPE "ReservationStatus" AS ENUM (
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
  'EXPIRED'
);

-- CreateTable: one physical table or seating area at an outlet.
-- Occupancy is MANUALLY updated by staff — there is no automatic detection.
CREATE TABLE "DiningTable" (
    "id"                 UUID          NOT NULL,
    "outletId"           UUID          NOT NULL,
    "label"              TEXT          NOT NULL,
    "capacity"           INTEGER       NOT NULL,
    "occupancy"          INTEGER       NOT NULL DEFAULT 0,
    "status"             "TableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "notes"              TEXT          NOT NULL DEFAULT '',
    "isActive"           BOOLEAN       NOT NULL DEFAULT true,
    "occupancyUpdatedAt" TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "DiningTable_pkey"            PRIMARY KEY ("id"),
    CONSTRAINT "DiningTable_capacity_check"  CHECK ("capacity" >= 1),
    CONSTRAINT "DiningTable_occupancy_check" CHECK ("occupancy" >= 0 AND "occupancy" <= "capacity")
);

-- CreateTable: a user's request to reserve a table at a specific time.
CREATE TABLE "TableReservation" (
    "id"              UUID                NOT NULL,
    "userId"          UUID                NOT NULL,
    "outletId"        UUID                NOT NULL,
    "tableId"         UUID,
    "partySize"       INTEGER             NOT NULL,
    "startsAt"        TIMESTAMP(3)        NOT NULL,
    "endsAt"          TIMESTAMP(3)        NOT NULL,
    "notes"           TEXT                NOT NULL DEFAULT '',
    "status"          "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "decisionReason"  TEXT,
    "decidedByUserId" UUID,
    "decidedAt"       TIMESTAMP(3),
    "cancelledAt"     TIMESTAMP(3),
    "completedAt"     TIMESTAMP(3),
    "expiredAt"       TIMESTAMP(3),
    "version"         INTEGER             NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)        NOT NULL,

    CONSTRAINT "TableReservation_pkey"          PRIMARY KEY ("id"),
    CONSTRAINT "TableReservation_partySize_check" CHECK ("partySize" >= 1),
    CONSTRAINT "TableReservation_time_check"    CHECK ("endsAt" > "startsAt")
);

-- CreateTable: append-only log of every state change on a reservation.
CREATE TABLE "ReservationStatusHistory" (
    "id"            UUID                 NOT NULL,
    "reservationId" UUID                 NOT NULL,
    "fromStatus"    "ReservationStatus",
    "toStatus"      "ReservationStatus"  NOT NULL,
    "actorUserId"   UUID,
    "actorRole"     "Role",
    "reason"        TEXT,
    "createdAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationStatusHistory_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DiningTable"
    ADD CONSTRAINT "DiningTable_outletId_fkey"
    FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableReservation"
    ADD CONSTRAINT "TableReservation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TableReservation"
    ADD CONSTRAINT "TableReservation_outletId_fkey"
    FOREIGN KEY ("outletId") REFERENCES "Outlet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TableReservation"
    ADD CONSTRAINT "TableReservation_tableId_fkey"
    FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TableReservation"
    ADD CONSTRAINT "TableReservation_decidedByUserId_fkey"
    FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationStatusHistory"
    ADD CONSTRAINT "ReservationStatusHistory_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "TableReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_outletId_label_key" ON "DiningTable"("outletId", "label");
CREATE INDEX "DiningTable_outletId_status_isActive_idx" ON "DiningTable"("outletId", "status", "isActive");

CREATE INDEX "TableReservation_userId_startsAt_idx" ON "TableReservation"("userId", "startsAt");
CREATE INDEX "TableReservation_outletId_startsAt_status_idx" ON "TableReservation"("outletId", "startsAt", "status");
CREATE INDEX "TableReservation_tableId_startsAt_status_idx" ON "TableReservation"("tableId", "startsAt", "status");

CREATE INDEX "ReservationStatusHistory_reservationId_createdAt_idx" ON "ReservationStatusHistory"("reservationId", "createdAt");
