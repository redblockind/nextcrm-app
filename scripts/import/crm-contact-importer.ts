#!/usr/bin/env node

/**
 * Amazon Connect CSV → NextCRM Contact Importer (Position-Based)
 * 
 * Uses column positions instead of header names for reliable parsing.
 * Column positions verified from Amazon Connect export format.
 */

import fs from 'fs';
import { prismadb } from '@/lib/prisma';

interface ImportResult {
  success: number;
  errors: number;
  errorLog: Array<{ row: number; name: string; reason: string }>;
}

// Column positions (0-indexed)
const COLUMN_MAP = {
  firstName: 5,              // Column 6
  lastName: 7,               // Column 8
  personalEmail: 15,         // Column 16
  b2bDiscountPercent: 60,    // Column 61
  city: 61,                  // Column 62
  contactOrigin: 63,         // Column 64
  country: 64,               // Column 65
  cumulativeOrderCount: 65,  // Column 66
  firstOrderDate: 66,        // Column 67
  guestStripeName: 67,       // Column 68
  isB2B: 68,                 // Column 69
  isTemporary: 69,           // Column 70
  lastOrderDate: 70,         // Column 71
  lastOrderId: 71,           // Column 72
  mailchimpDateCreated: 73,  // Column 74
  mailchimpFullName: 74,     // Column 75
  mailchimpStreetAddress: 75, // Column 76
  mailchimpTags: 76,         // Column 77
  optInTime: 77,             // Column 78
  state: 79,                 // Column 80
  stripeCreateDate: 81,      // Column 82 (used for created_on - but we're not using it)
  stripeCustomerId: 81,      // Column 82
  stripeName: 82,            // Column 83
};

class ContactImporter {
  private results: ImportResult = {
    success: 0,
    errors: 0,
    errorLog: [],
  };

  private rowNumber = 0;

  /**
   * Parse CSV line
   */
  private parseLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  /**
   * Parse name from full name string
   */
  private parseName(fullName?: string): { firstName?: string; lastName?: string } {
    if (!fullName || fullName.trim().length === 0) return {};
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 0) return {};
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || undefined;
    return { firstName: firstName || undefined, lastName };
  }

  /**
   * Convert string to boolean
   */
  private toBoolean(value?: string): boolean | null {
    if (!value || value.trim().length === 0) return null;
    const lower = value.toString().toLowerCase().trim();
    return ['true', '1', 'yes'].includes(lower) ? true : false;
  }

  /**
   * Parse Mailchimp street address for city, state, country
   */
  private parseAddress(addressStr?: string): {
    city?: string;
    state?: string;
    country?: string;
  } {
    if (!addressStr || addressStr.trim().length === 0) return {};

    const result: { city?: string; state?: string; country?: string } = {};
    const parts = addressStr
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length >= 1) result.city = parts[0];
    if (parts.length >= 2) result.state = parts[1];
    if (parts.length >= 3) result.country = parts[parts.length - 1];

    return result;
  }

  /**
   * Parse Mailchimp tags from string
   */
  private parseTags(tagsStr?: string): string[] {
    if (!tagsStr || tagsStr.trim().length === 0) {
      return ['imported-from-amazon-connect'];
    }

    // Extract all quoted strings (anything between opening and closing quotes)
    const tagMatches = tagsStr.match(/["'][^"']*["']/g) || [];
    const tags = tagMatches
      .map((tag) => tag.replace(/^["']|["']$/g, '').trim())
      .filter((tag) => tag.length > 0);

    const uniqueTags = Array.from(new Set([...tags, 'imported-from-amazon-connect']));
    return uniqueTags;
  }

  /**
   * Build notes array from unmapped fields
   */
  private buildNotes(values: string[]): string[] {
    const notes: string[] = [];

    const confirmTime = values[COLUMN_MAP.contactOrigin]?.trim();
    if (confirmTime) {
      notes.push(`ConfirmTime: ${confirmTime}`);
    }

    const mailchimpDate = values[COLUMN_MAP.mailchimpDateCreated]?.trim();
    if (mailchimpDate) {
      notes.push(`MailListDateCreated: ${mailchimpDate}`);
    }

    const addressStr = values[COLUMN_MAP.mailchimpStreetAddress]?.trim();
    if (addressStr) {
      const parsed = this.parseAddress(addressStr);
      if (!parsed.city && !parsed.state && !parsed.country) {
        notes.push(`MailchimpStreetAddress: ${addressStr}`);
      }
    }

    return notes;
  }

  /**
   * Transform CSV row to contact data (position-based)
   */
  private transformRow(values: string[]): any {
    // Extract by position
    let firstName = values[COLUMN_MAP.firstName]?.trim() || undefined;
    let lastName = values[COLUMN_MAP.lastName]?.trim() || undefined;
    const email = values[COLUMN_MAP.personalEmail]?.trim();

    // Enrich names from Mailchimp/Stripe if primary is missing
    if (!firstName || !lastName) {
      const mailchimpName = this.parseName(values[COLUMN_MAP.mailchimpFullName]?.trim());
      if (mailchimpName.firstName && !firstName) firstName = mailchimpName.firstName;
      if (mailchimpName.lastName && !lastName) lastName = mailchimpName.lastName;
    }

    if (!firstName || !lastName) {
      const stripeName = this.parseName(values[COLUMN_MAP.stripeName]?.trim());
      if (stripeName.firstName && !firstName) firstName = stripeName.firstName;
      if (stripeName.lastName && !lastName) lastName = stripeName.lastName;
    }

    if (!firstName || !lastName) {
      const guestName = this.parseName(values[COLUMN_MAP.guestStripeName]?.trim());
      if (guestName.firstName && !firstName) firstName = guestName.firstName;
      if (guestName.lastName && !lastName) lastName = guestName.lastName;
    }

    // Last name fallback
    if (!lastName) {
      if (email) {
        lastName = email;
      } else {
        return null;
      }
    }

    // Parse address (primary sources)
    let city = values[COLUMN_MAP.city]?.trim() || undefined;
    let state = values[COLUMN_MAP.state]?.trim() || undefined;
    let country = values[COLUMN_MAP.country]?.trim() || undefined;

    // Fallback: parse from Mailchimp address if primary missing
    if (!city || !state || !country) {
      const addressParts = this.parseAddress(values[COLUMN_MAP.mailchimpStreetAddress]?.trim());
      if (addressParts.city && !city) city = addressParts.city;
      if (addressParts.state && !state) state = addressParts.state;
      if (addressParts.country && !country) country = addressParts.country;
    }

    // Build contact data
    const contactData: any = {
      first_name: firstName,
      last_name: lastName,
      email: email,
      status: true,
      tags: this.parseTags(values[COLUMN_MAP.mailchimpTags]?.trim()),
      notes: this.buildNotes(values),
      city,
      country,
      state,
      is_b2b: this.toBoolean(values[COLUMN_MAP.isB2B]?.trim()),
      b2b_discount_percent: values[COLUMN_MAP.b2bDiscountPercent]?.trim() || undefined,
      contact_origin: values[COLUMN_MAP.contactOrigin]?.trim() || undefined,
      cumulative_order_count: values[COLUMN_MAP.cumulativeOrderCount]?.trim() || undefined,
      first_order_date: values[COLUMN_MAP.firstOrderDate]?.trim() || undefined,
      is_temporary: this.toBoolean(values[COLUMN_MAP.isTemporary]?.trim()),
      last_order_date: values[COLUMN_MAP.lastOrderDate]?.trim() || undefined,
      last_order_id: values[COLUMN_MAP.lastOrderId]?.trim() || undefined,
      opt_in_time: values[COLUMN_MAP.optInTime]?.trim() || undefined,
      stripe_customer_id: values[COLUMN_MAP.stripeCustomerId]?.trim() || undefined,
    };

    // Remove undefined values
    Object.keys(contactData).forEach(
      (key) => contactData[key] === undefined && delete contactData[key]
    );

    return contactData;
  }

  /**
   * Import a single contact
   */
  private async importContact(values: string[]): Promise<void> {
    this.rowNumber++;

    try {
      const contactData = this.transformRow(values);
      if (!contactData) {
        this.results.errors++;
        this.results.errorLog.push({
          row: this.rowNumber,
          name: 'N/A',
          reason: 'Missing required fields',
        });
        return;
      }

      await prismadb.crm_Contacts.create({
        data: contactData,
      });

      this.results.success++;
      console.log(`✓ Row ${this.rowNumber}: ${contactData.first_name} ${contactData.last_name}`);
    } catch (error: any) {
      this.results.errors++;
      const errorMsg = error?.message || String(error);
      this.results.errorLog.push({
        row: this.rowNumber,
        name: `${values[COLUMN_MAP.firstName]} ${values[COLUMN_MAP.lastName]}`,
        reason: errorMsg,
      });
      console.error(`✗ Row ${this.rowNumber}: ${errorMsg}`);
    }
  }

  /**
   * Run the import
   */
  public async run(csvFilePath: string): Promise<void> {
    if (!fs.existsSync(csvFilePath)) {
      console.error(`❌ CSV file not found: ${csvFilePath}`);
      process.exit(1);
    }

    console.log(`\n🚀 Starting import from: ${csvFilePath}\n`);

    const content = fs.readFileSync(csvFilePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    if (lines.length < 2) {
      console.error('❌ CSV file has no data rows');
      process.exit(1);
    }

    // Skip header line, process data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseLine(line);
      await this.importContact(values);
    }

    this.printSummary();
  }

  /**
   * Print import summary
   */
  private printSummary(): void {
    const total = this.results.success + this.results.errors;

    console.log('\n' + '='.repeat(60));
    console.log('📊 IMPORT SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total rows processed:  ${total}`);
    console.log(`✓ Successfully created: ${this.results.success}`);
    console.log(`✗ Errors:               ${this.results.errors}`);
    console.log('='.repeat(60));

    if (this.results.errorLog.length > 0) {
      console.log('\n❌ Error Details:\n');
      this.results.errorLog.forEach((log) => {
        console.log(`  Row ${log.row} (${log.name}): ${log.reason}`);
      });
    }

    console.log('\n✅ Import complete!\n');
  }
}

async function main() {
  const csvFilePath = process.argv[2];

  if (!csvFilePath) {
    console.error('❌ Usage: npx tsx scripts/import/crm-contact-importer.ts <csv-file-path>');
    console.error('Example: npx tsx scripts/import/crm-contact-importer.ts scripts/import/test-contacts.csv');
    process.exit(1);
  }

  try {
    const importer = new ContactImporter();
    await importer.run(csvFilePath);
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
