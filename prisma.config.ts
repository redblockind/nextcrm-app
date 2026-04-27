import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: {
    url:
      process.env.DATABASE_URL ??
      process.env.NETLIFY_DATABASE_URL_UNPOOLED ??
      process.env.NETLIFY_DATABASE_URL ??
      "",
  },
  migrations: {
    seed: "npx tsx prisma/seeds/seed.ts",
  },
});
