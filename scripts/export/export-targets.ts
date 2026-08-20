import * as fs from "fs";
import * as path from "path";
import { prismadb } from "@/lib/prisma";

const prisma = prismadb;

async function exportTargets() {
  try {
    console.log("Fetching all targets...");

    const targets = await prisma.crm_Targets.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        created_on: "desc",
      },
    });

    if (targets.length === 0) {
      console.log("No targets found to export.");
      return;
    }

    console.log(`Found ${targets.length} targets. Generating CSV...`);

    // Define all field names in the order they should appear
    const headers = [
      "id",
      "first_name",
      "last_name",
      "email",
      "mobile_phone",
      "office_phone",
      "company",
      "company_website",
      "personal_website",
      "position",
      "social_x",
      "social_linkedin",
      "social_instagram",
      "social_facebook",
      "status",
      "tags",
      "notes",
      "created_by",
      "created_on",
      "updatedAt",
      "updatedBy",
      "personal_email",
      "company_email",
      "company_phone",
      "city",
      "country",
      "industry",
      "employees",
      "description",
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
      "converted_at",
      "converted_account_id",
      "converted_contact_id",
    ];

    // Helper function to escape CSV values
    const escapeCsvValue = (value: unknown): string => {
      if (value === null || value === undefined) {
        return "";
      }

      if (Array.isArray(value)) {
        // For tags and notes (arrays), join with semicolon and quote
        const joined = value.join("; ");
        return `"${joined.replace(/"/g, '""')}"`;
      }

      const str = String(value);

      // If the value contains comma, quote, or newline, wrap in quotes and escape quotes
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }

      return str;
    };

    // Build CSV header row
    const csvLines: string[] = [headers.join(",")];

    // Build data rows
    for (const target of targets) {
      const row = headers.map((header) => {
        const value = (target as any)[header];
        return escapeCsvValue(value);
      });
      csvLines.push(row.join(","));
    }

    const csvContent = csvLines.join("\n");

    // Write to file
    const timestamp = new Date().toISOString().slice(0, 10);
    const filePath = path.join(
      process.cwd(),
      "exports",
      `targets-export-${timestamp}.csv`
    );

    // Ensure exports directory exists
    const exportsDir = path.join(process.cwd(), "exports");
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    fs.writeFileSync(filePath, csvContent, "utf-8");

    console.log(`✅ Export successful!`);
    console.log(`📁 File saved to: ${filePath}`);
    console.log(`📊 Total targets exported: ${targets.length}`);
  } catch (error) {
    console.error("❌ Export failed:", error);
    process.exit(1);
  }
}

exportTargets();
