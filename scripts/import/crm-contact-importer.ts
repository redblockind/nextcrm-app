#!/usr/bin/env node

/**
 * Amazon Connect CSV → NextCRM Contact Importer
 * 
 * This script imports contacts from an Amazon Connect CSV export into NextCRM.
 * It follows the mapping defined in CSV_IMPORT_MAPPING_UPDATED.md
 * 
 * Usage:
 *   npx ts-node scripts/import/crm-contact-importer.ts <csv-file-path>
 * 
 * Example:
 *   npx ts-node scripts/import/crm-contact-importer.ts scripts/import/test-contacts.csv
 */

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { prismadb } from '@/lib/prisma';

interface CSVRow {
  FirstName?: string;
  LastName?: string;
  PersonalEmailAddress?: string;
  'Attributes.B2BDiscountPercent'?: string;
  'Attributes.City'?: string;
  'Attributes.ConfirmTime'?: string;
  'Attributes.ContactOrigin'?: string;
  'Attributes.Country'?: string;
  'Attributes.CumulativeOrderCount'?: string;
  'Attributes.FirstOrderDate'?: string;
  'Attributes.GuestStripeName'?: string;
  'Attributes.IsB2B'?: string;
  'Attributes.IsTemporary'?: string;
  'Attributes.LastOrderDate'?: string;
  'Attributes.LastOrderId'?: string;
  'Attributes.MailchimpDateCreated'?: string;
  'Attributes.MailchimpFullName'?: string;
  'Attributes.MailchimpStreetAddress'?: string;
  'Attributes.MailchimpTags'?: string;
  'Attributes.OptInTime'?: string;
  'Attributes.State'?: string;
  'Attributes.StripeCreateDate'?: string;
  'Attributes.StripeCustomerId'?: string;
  'Attributes.StripeName'?: string;
  [key: string]: any;
}

interface ImportResult {
  success: number;
  duplicates: number;
  errors: number;
  skipped: number;
  errorLog: Array<{ row: number; email: string; reason: string }>;
}

class ContactImporter {
  private results: ImportResult = {
    success: 0,
    duplicates: 0,
    errors: 0,
    skipped: 0,
    errorLog: [],
  };

  private rowNumber = 0;

  /**
   * Parse name from full name string
   */
  private parseName(fullName?: string): { firstName?: string; lastName?: string } {
    if (!fullName) return {};
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 0) return {};
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || '';
    return { firstName, lastName };
  }

  /**
   * Convert string to boolean
   */
  private toBoolean(value?: string): boolean | null {
    if (!value) return null;
    const lower = value.toString().toLowerCase();
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
    if (!addressStr) return {};

    const result: {
      city?: string;
      state?: string;
      country?: string;
    } = {};

    // Split on comma and spaces
    const parts = addressStr
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Very basic parsing - try to identify components
    // This is best-effort; unparseable data goes to notes
    if (parts.length >= 1) result.city = parts[0];
    if (parts.length >= 2) result.state = parts[1];
    if (parts.length >= 3) result.country = parts[parts.length - 1];

    return result;
  }

  /**
   * Parse Mailchimp tags from string
   */
  private parseTags(tagsStr?: string): string[] {
    if (!tagsStr) return [];

    // Split on quotes or commas
    const tags = tagsStr
      .split(/["',]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Always add import tag
    const allTags = [...new Set([...tags, 'imported-from-amazon-connect'])];
    return allTags;
  }

  /**
   * Build notes array from unmapped fields
   */
  private buildNotes(row: CSVRow): string[] {
    const notes: string[] = [];

    if (row['Attributes.ConfirmTime']) {
      notes.push(`ConfirmTime: ${row['Attributes.ConfirmTime']}`);
    }
    if (row['Attributes.MailchimpDateCreated']) {
      notes.push(`MailchimpDateCreated: ${row['Attributes.MailchimpDateCreated']}`);
    }

    // If address parsing failed, store full address in notes
    const addressStr = row['Attributes.MailchimpStreetAddress'];
    if (addressStr) {
      const parsed = this.parseAddress(addressStr);
      // If we couldn't parse it well, save the original
      if (!parsed.city && !parsed.state && !parsed.country) {
        notes.push(`MailchimpStreetAddress: ${addressStr}`);
      }
    }

    return notes;
  }

  /**
   * Transform CSV row to contact data
   */
  private transformRow(row: CSVRow): any {
    let firstName = row.FirstName;
    let lastName = row.LastName;
    const email = row.PersonalEmailAddress;

    // Enrich names from Mailchimp/Stripe data if primary is missing
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

    // Last name fallback: use email if no last name
    if (!lastName) {
      if (email) {
        lastName = email;
      } else {
        return null; // Cannot create contact without last_name
      }
    }

    // Parse address (primary sources)
    let city = row['Attributes.City'];
    let state = row['Attributes.State'];
    let country = row['Attributes.Country'];

    // Fallback: parse from Mailchimp address if primary missing
    if (!city || !state || !country) {
      const addressParts = this.parseAddress(row['Attributes.MailchimpStreetAddress']);
      if (addressParts.city && !city) city = addressParts.city;
      if (addressParts.state && !state) state = addressParts.state;
      if (addressParts.country && !country) country = addressParts.country;
    }

    // Build the contact data object
    const contactData: any = {
      first_name: firstName || undefined,
      last_name: lastName,
      email: email || undefined,
      status: true,
      tags: this.parseTags(row['Attributes.MailchimpTags']),
      notes: this.buildNotes(row),
      // Custom fields
      city: city || undefined,
      country: country || undefined,
      state: state || undefined,
      is_b2b: this.toBoolean(row['Attributes.IsB2B']),
      b2b_discount_percent: row['Attributes.B2BDiscountPercent'] || undefined,
      contact_origin: row['Attributes.ContactOrigin'] || undefined,
      cumulative_order_count: row['Attributes.CumulativeOrderCount'] || undefined,
      first_order_date: row['Attributes.FirstOrderDate'] || undefined,
      is_temporary: this.toBoolean(row['Attributes.IsTemporary']),
      last_order_date: row['Attributes.LastOrderDate'] || undefined,
      last_order_id: row['Attributes.LastOrderId'] || undefined,
      opt_in_time: row['Attributes.OptInTime'] || undefined,
      stripe_customer_id: row['Attributes.StripeCustomerId'] || undefined,
    };

    // Remove undefined values
    Object.keys(contactData).forEach(
      (key) => contactData[key] === undefined && delete contactData[key]
    );

    return contactData;
  }

  /**
   * Check if contact already exists by email
   */
  private async checkDuplicate(email?: string): Promise<boolean> {
    if (!email) return false;
    const existing = await prismadb.crm_Contacts.findFirst({
      where: { email, deletedAt: null },
    });
    return !!existing;
  }

  /**
   * Import a single contact
   */
  private async importContact(row: CSVRow): Promise<void> {
    this.rowNumber++;

    try {
      // Transform row
      const contactData = this.transformRow(row);
      if (!contactData) {
        this.results.skipped++;
        this.results.errorLog.push({
          row: this.rowNumber,
          email: row.PersonalEmailAddress || 'N/A',
          reason: 'Missing required fields (first_name + last_name)',
        });
        return;
      }

      const email = row.PersonalEmailAddress;

      // Check for duplicates
      const isDuplicate = await this.checkDuplicate(email);
      if (isDuplicate) {
        this.results.duplicates++;
        this.results.errorLog.push({
          row: this.rowNumber,
          email: email || 'N/A',
          reason: 'Duplicate email already exists',
        });
        return;
      }

      // Create contact
      await prismadb.crm_Contacts.create({
        data: {
          ...contactData,
          last_name: contactData.last_name,
        },
      });

      this.results.success++;
      console.log(`✓ Row ${this.rowNumber}: ${contactData.first_name} ${contactData.last_name}`);
    } catch (error) {
      this.results.errors++;
      const errorMsg = error instanceof Error ? error.message : String(error);
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
    // Validate file exists
    if (!fs.existsSync(csvFilePath)) {
      console.error(`❌ CSV file not found: ${csvFilePath}`);
      process.exit(1);
    }

    console.log(`\n🚀 Starting import from: ${csvFilePath}\n`);

    return new Promise((resolve, reject) => {
      fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', async (row: CSVRow) => {
          await this.importContact(row);
        })
        .on('end', () => {
          this.printSummary();
          resolve();
        })
        .on('error', (error) => {
          console.error('❌ CSV parsing error:', error);
          reject(error);
        });
    });
  }

  /**
   * Print import summary
   */
  private printSummary(): void {
    const total = this.results.success + this.results.duplicates + this.results.errors + this.results.skipped;

    console.log('\n' + '='.repeat(60));
    console.log('📊 IMPORT SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total rows processed:  ${total}`);
    console.log(`✓ Successfully created: ${this.results.success}`);
    console.log(`⚠ Duplicates skipped:   ${this.results.duplicates}`);
    console.log(`⚠ Skipped (missing):    ${this.results.skipped}`);
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

// Main
async function main() {
  const csvFilePath = process.argv[2];

  if (!csvFilePath) {
    console.error('❌ Usage: npx ts-node scripts/import/crm-contact-importer.ts <csv-file-path>');
    console.error('Example: npx ts-node scripts/import/crm-contact-importer.ts scripts/import/test-contacts.csv');
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
