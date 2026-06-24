/**
 * Report the `role` distribution on the Users table.
 * Idempotent: read-only, safe to run multiple times.
 *
 * Background: user roles are assigned at import time by
 * `transformers/users-transformer.ts`, which maps the source MongoDB
 * `is_admin` flag onto the `role` enum. The Postgres schema no longer
 * carries the old `is_admin` / `is_account_admin` boolean columns, so
 * there is nothing left to backfill from after import. This script now
 * simply verifies how roles are distributed.
 *
 * Valid `role` values (see `AppRole` in prisma/schema.prisma): user | manager | admin
 *
 * Run: npx tsx scripts/migration/backfill-roles.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Checking role distribution...");

  const summary = await prisma.users.groupBy({
    by: ["role"],
    _count: { role: true },
  });
  console.log("Role distribution:", summary);

  console.log("Role check complete.");
}

main()
  .catch((e) => {
    console.error("Role check failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
