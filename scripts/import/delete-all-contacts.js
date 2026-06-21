const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function deleteAllContacts() {
  try {
    console.log('🗑️  Deleting all contacts...');
    // crm_Contact_Enrichment.contactId is ON DELETE RESTRICT, so any
    // enrichment rows must be removed before the contacts themselves.
    const [enrichments, contacts] = await prisma.$transaction([
      prisma.crm_Contact_Enrichment.deleteMany({}),
      prisma.crm_Contacts.deleteMany({}),
    ]);
    console.log(`✓ Deleted ${enrichments.count} enrichment records`);
    console.log(`✓ Deleted ${contacts.count} contacts`);
    await prisma.$disconnect();
    console.log('✅ Done!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

deleteAllContacts();
