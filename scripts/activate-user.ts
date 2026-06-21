import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.argv[2];
  
  if (!email) {
    console.error("Please provide an email address: pnpm tsx scripts/activate-user.ts <email>");
    process.exit(1);
  }

  const user = await prisma.users.findUnique({
    where: { email },
  });

  if (!user) {
    console.error(`User with email ${email} not found`);
    process.exit(1);
  }

  const updated = await prisma.users.update({
    where: { email },
    data: {
      userStatus: "ACTIVE",
    },
  });

  console.log(`✓ User ${email} activated successfully`);
  console.log(`  ID: ${updated.id}`);
  console.log(`  Status: ${updated.userStatus}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
