-- AlterEnum: add persona role values.
-- ADD VALUE is safe on PostgreSQL 12+: it is a metadata-only change that cannot
-- be rolled back inside a transaction, but it does not affect existing rows.
ALTER TYPE "Role" ADD VALUE 'FACULTY';
ALTER TYPE "Role" ADD VALUE 'STAFF';
ALTER TYPE "Role" ADD VALUE 'EXECUTIVE';
ALTER TYPE "Role" ADD VALUE 'GUEST';
