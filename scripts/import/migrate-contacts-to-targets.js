/**
 * One-time data migration: sync custom field values from contacts to targets.
 *
 * For each non-deleted contact:
 *   - Find matching target by email (case-insensitive).
 *   - If match: update target with custom fields from the contact.
 *   - If no match (e.g. the 2 Stripe customers): create a new target.
 * Maps city, country. Drops state (no target-level equivalent).
 *
 * Run: node scripts/import/migrate-contacts-to-targets.js
 */

const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");

const connectionString = process.env.DATABASE_URL || "";
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CUSTOM_FIELDS = [
  "stripe_customer_id",
  "first_order_date",
  "last_order_date",
  "last_order_id",
  "cumulative_order_count",
  "contact_origin",
  "opt_in_time",
  "is_b2b",
  "b2b_discount_percent",
  "is_temporary",
];

function buildUpdateData(contact) {
  const data = {};
  for (const field of CUSTOM_FIELDS) {
    if (contact[field] !== null && contact[field] !== undefined) {
      data[field] = contact[field];
    }
  }
  if (contact.city) data.city = contact.city;
  if (contact.country) data.country = contact.country;
  return data;
}

function buildCreateData(contact) {
  const data = {
    first_name: contact.first_name || undefined,
    last_name: contact.last_name,
    email: contact.email || undefined,
    mobile_phone: contact.mobile_phone || undefined,
    office_phone: contact.office_phone || undefined,
    company: undefined,
    position: contact.position || undefined,
    status: contact.status ?? true,
    tags: contact.tags || [],
    notes: contact.notes || [],
    city: contact.city || undefined,
    country: contact.country || undefined,
    description: contact.description || undefined,
  };

  for (const field of CUSTOM_FIELDS) {
    if (contact[field] !== null && contact[field] !== undefined) {
      data[field] = contact[field];
    }
  }

  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  return data;
}

async function run() {
  console.log("\n--- Contact → Target migration ---\n");

  const contacts = await prisma.crm_Contacts.findMany({
    where: { deletedAt: null },
  });
  console.log(`Found ${contacts.length} non-deleted contacts.\n`);

  let updated = 0;
  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const contact of contacts) {
    const email = (contact.email || "").trim();
    if (!email) {
      skipped++;
      console.log(`  SKIP (no email): ${contact.first_name} ${contact.last_name}`);
      continue;
    }

    try {
      const matchingTargets = await prisma.crm_Targets.findMany({
        where: {
          email: { equals: email, mode: "insensitive" },
          deletedAt: null,
        },
        select: { id: true },
      });

      if (matchingTargets.length === 1) {
        const updateData = buildUpdateData(contact);
        if (Object.keys(updateData).length > 0) {
          await prisma.crm_Targets.update({
            where: { id: matchingTargets[0].id },
            data: updateData,
          });
          updated++;
          console.log(`  UPDATE: ${email} → target ${matchingTargets[0].id}`);
        } else {
          skipped++;
          console.log(`  SKIP (nothing to update): ${email}`);
        }
      } else if (matchingTargets.length === 0) {
        const createData = buildCreateData(contact);
        const newTarget = await prisma.crm_Targets.create({ data: createData });
        created++;
        console.log(`  CREATE: ${email} → new target ${newTarget.id}`);
      } else {
        skipped++;
        console.log(`  SKIP (multiple target matches): ${email} (${matchingTargets.length} matches)`);
      }
    } catch (err) {
      errors.push({ email, error: err.message });
      console.error(`  ERROR: ${email} – ${err.message}`);
    }
  }

  console.log("\n=== MIGRATION SUMMARY ===");
  console.log(`Contacts processed: ${contacts.length}`);
  console.log(`Targets updated:    ${updated}`);
  console.log(`Targets created:    ${created}`);
  console.log(`Skipped:            ${skipped}`);
  console.log(`Errors:             ${errors.length}`);
  if (errors.length > 0) {
    console.log("\nError details:");
    errors.forEach((e) => console.log(`  ${e.email}: ${e.error}`));
  }

  // Verification: count comparison
  const targetCount = await prisma.crm_Targets.count({ where: { deletedAt: null } });
  const contactCount = await prisma.crm_Contacts.count({ where: { deletedAt: null } });
  console.log(`\nVerification: ${contactCount} active contacts, ${targetCount} active targets`);
  if (targetCount >= contactCount) {
    console.log("OK – target count >= contact count.\n");
  } else {
    console.log("WARNING – fewer targets than contacts. Investigate before deleting contacts.\n");
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
