#!/usr/bin/env node

/**
 * Amazon Connect CSV → NextCRM Contact Importer (Simplified)
 * 
 * Imports contacts from Amazon Connect CSV without dedup or fallback logic.
 * - Every record has an email (no dedup needed)
 * - No duplicate emails in dataset
 * - Direct field mapping
 * 
 * Usage:
 *   npx tsx scripts/import/crm-contact-importer.ts <csv-file-path>
 */

import fs from 'fs';
import { prismadb } from '@/lib/prisma';

interface ImportResult {
  success: number;
  errors: number;
  errorLog: Array<{ row: number; email: string; reason: string }>;
}

class ContactImporter {
  private results: ImportResult = {
    success: 0,
    errors: 0,
    errorLog: [],
  };

  private rowNumber = 0;

  /**
   * Parse CSV line (basic CSV parsing)
   */
  private parseCSVLine(line: string): string[] {
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

    const cleaned = tagsStr.replace(/^["']|["']$/g, '').replace(/["']/g, '');
    const tags = cleaned
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const uniqueTags = Array.from(new Set([...tags, 'imported-from-amazon-connect']));
    return uniqueTags;
  }

  /**
   * Build notes array from unmapped fields
   */
  private buildNotes(row: Record<string, string>): string[] {
    const notes: string[] = [];

    if (row['Attributes.ConfirmTime']) {
      notes.push(`ConfirmTime: ${row['Attributes.ConfirmTime']}`);
    }
    if (row['Attributes.MailchimpDateCreated']) {
      notes.push(`MailchimpDateCreated: ${row['Attributes.MailchimpDateCreated']}`);
    }

    const addressStr = row['Attributes.MailchimpStreetAddress'];
    if (addressStr && addressStr.trim().length > 0) {
      const parsed = this.parseAddress(addressStr);
      if (!parsed.city && !parsed.state && !parsed.country) {
        notes.push(`MailchimpStreetAddress: ${addressStr}`);
      }
    }

    return notes;
  }

  /**
   * Transform CSV row to contact data
   */
  private transformRow(row: Record<string, string>): any {
    // Use names as-is from CSV
    let firstName = row.FirstName?.trim() || undefined;
    let lastName = row.LastName?.trim() || undefined;
    const email = row.PersonalEmailAddress?.trim();

    // Enrich names from Mailchimp/Stripe ONLY if primary is missing
    if (!firstName || !lastName) {
      const mailchimpName = this.parseName(row['Attributes.MailchimpFullName']);
      if (mailchimpName.firstName && !firstName) firstName = mailchimpName.firstName;
      if (mailchimpName.lastName && !lastName) lastName = mailchimpName.lastName;
    }

    if (!firstName || !lastName) {
      const stripeName = this.parseName(row['Attributes.StripeName']);
      if (stripeName.firstName && !firstName) firstName = stripeName.firstName;
      if (stripeName.lastName && !lastName) lastName = stripeName.lastName;
    }

    if (!firstName || !lastName) {
      const guestName = this.parseName(row['Attributes.GuestStripeName']);
      if (guestName.firstName && !firstName) firstName = guestName.firstName;
      if (guestName.lastName && !lastName) lastName = guestName.lastName;
    }

    // Parse address (primary sources)
    let city = row['Attributes.City']?.trim() || undefined;
    let state = row['Attributes.State']?.trim() || undefined;
    let country = row['Attributes.Country']?.trim() || undefined;

    // Fallback: parse from Mailchimp address if primary missing
    if (!city || !state || !country) {
      const addressParts = this.parseAddress(row['Attributes.MailchimpStreetAddress']);
      if (addressParts.city && !city) city = addressParts.city;
      if (addressParts.state && !state) state = addressParts.state;
      if (addressParts.country && !country) country = addressParts.country;
    }

    // Build contact data
    const contactData: any = {
      first_name: firstName,
      last_name: lastName || email, // Use email as last_name fallback if no last_name
      email: email,
      status: true,
      tags: this.parseTags(row['Attributes.MailchimpTags']),
      notes: this.buildNotes(row),
      city,
      country,
      state,
      is_b2b: this.toBoolean(row['Attributes.IsB2B']),
      b2b_discount_percent: row['Attributes.B2BDiscountPercent']?.trim() || undefined,
      contact_origin: row['Attributes.ContactOrigin']?.trim() || undefined,
      cumulative_order_count: row['Attributes.CumulativeOrderCount']?.trim() || undefined,
      first_order_date: row['Attributes.FirstOrderDate']?.trim() || undefined,
      is_temporary: this.toBoolean(row['Attributes.IsTemporary']),
      last_order_date: row['Attributes.LastOrderDate']?.trim() || undefined,
      last_order_id: row['Attributes.LastOrderId']?.trim() || undefined,
      opt_in_time: row['Attributes.OptInTime']?.trim() || undefined,
      stripe_customer_id: row['Attributes.StripeCustomerId']?.trim() || undefined,
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
  private async importContact(row: Record<string, string>): Promise<void> {
    this.rowNumber++;

    try {
      const contactData = this.transformRow(row);

      // Create contact (no dedup checks)
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
        email: row.PersonalEmailAddress || 'N/A',
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

    const headerLine = lines[0];
    const headers = this.parseCSVLine(headerLine);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = this.parseCSVLine(line);
      const row: Record<string, string> = {};

      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });

      await this.importContact(row);
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
        console.log(`  Row ${log.row} (${log.email}): ${log.reason}`);
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
