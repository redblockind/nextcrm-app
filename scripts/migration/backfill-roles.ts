/**
 * Backfill the `role` column from existing `is_admin` / `is_account_admin` flags.
 * Idempotent: safe to run multiple times.
 *
 * The `role` column is the AppRole enum: "user" | "manager" | "admin".
 * Only global admins are promoted; everyone else keeps the schema
 * default of "user".
 *
 * Mapping:
 *   is_admin = true              → role = "admin"
 *   otherwise                    → role = "user" (default, left untouched)
 *
 * Run: npx tsx scripts/migration/backfill-roles.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting role backfill...");

  // Admins first (is_admin takes precedence). Only touch rows still at the
  // default role so the script stays idempotent.
  const adminResult = await prisma.users.updateMany({
    where: { is_admin: true, role: "user" },
    data: { role: "admin" },
  });
  console.log(`  Updated ${adminResult.count} users to role=admin`);

  // Everyone else keeps the default role = "user".

  const summary = await prisma.users.groupBy({
    by: ["role"],
    _count: { role: true },
  });
  console.log("Role distribution:", summary);

  console.log("Role backfill complete.");
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
