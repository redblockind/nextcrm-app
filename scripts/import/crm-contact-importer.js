#!/usr/bin/env node

/**
 * Amazon Connect CSV → NextCRM Contact Importer
 * 
 * This script imports contacts from an Amazon Connect CSV export into NextCRM.
 * It follows the mapping defined in CSV_IMPORT_MAPPING_UPDATED.md
 * 
 * Usage:
 *   node scripts/import/crm-contact-importer.js <csv-file-path>
 * 
 * Example:
 *   node scripts/import/crm-contact-importer.js scripts/import/test-contacts.csv
 */

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prismadb = new PrismaClient();

class ContactImporter {
  constructor() {
    this.results = {
      success: 0,
      duplicates: 0,
      errors: 0,
      skipped: 0,
      errorLog: [],
    };
    this.rowNumber = 0;
  }

  /**
   * Parse CSV line (basic CSV parsing)
   */
  parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++; // Skip next quote
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
  parseName(fullName) {
    if (!fullName) return {};
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 0) return {};
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ') || '';
    return { 
      firstName: firstName || undefined, 
      lastName: lastName || undefined 
    };
  }

  /**
   * Convert string to boolean
   */
  toBoolean(value) {
    if (!value) return null;
    const lower = value.toString().toLowerCase().trim();
    return ['true', '1', 'yes'].includes(lower) ? true : false;
  }

  /**
   * Parse Mailchimp street address for city, state, country
   */
  parseAddress(addressStr) {
    if (!addressStr) return {};

    const result = {};
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
  parseTags(tagsStr) {
    if (!tagsStr) return ['imported-from-amazon-connect'];

    // Remove quotes and split
    const cleaned = tagsStr
      .replace(/^["']|["']$/g, '')
      .replace(/["']/g, '');

    const tags = cleaned
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Always add import tag
    const uniqueTags = Array.from(new Set([...tags, 'imported-from-amazon-connect']));
    return uniqueTags;
  }

  /**
   * Build notes array from unmapped fields
   */
  buildNotes(row) {
    const notes = [];

    if (row['Attributes.ConfirmTime']) {
      notes.push(`ConfirmTime: ${row['Attributes.ConfirmTime']}`);
    }
    if (row['Attributes.MailchimpDateCreated']) {
      notes.push(`MailListDateCreated: ${row['Attributes.MailchimpDateCreated']}`);
    }

    const addressStr = row['Attributes.MailchimpStreetAddress'];
    if (addressStr) {
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
  transformRow(row) {
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
        return null;
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
    const contactData = {
      first_name: firstName || undefined,
      last_name: lastName,
      email: email || undefined,
      status: true,
      tags: this.parseTags(row['Attributes.MailchimpTags']),
      notes: this.buildNotes(row),
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
  async checkDuplicate(email) {
    if (!email) return false;
    const existing = await prismadb.crm_Contacts.findFirst({
      where: { email, deletedAt: null },
    });
    return !!existing;
  }

  /**
   * Import a single contact
   */
  async importContact(row) {
    this.rowNumber++;

    try {
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

      await prismadb.crm_Contacts.create({
        data: {
          ...contactData,
          last_name: contactData.last_name,
        },
      });

      this.results.success++;
      console.log(`✓ Row ${this.rowNumber}: ${contactData.first_name || ''} ${contactData.last_name}`);
    } catch (error) {
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
  async run(csvFilePath) {
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
      const row = {};

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
  printSummary() {
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

async function main() {
  const csvFilePath = process.argv[2];

  if (!csvFilePath) {
    console.error('❌ Usage: node scripts/import/crm-contact-importer.js <csv-file-path>');
    console.error('Example: node scripts/import/crm-contact-importer.js scripts/import/test-contacts.csv');
    process.exit(1);
  }

  try {
    const importer = new ContactImporter();
    await importer.run(csvFilePath);
    await prismadb.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    await prismadb.$disconnect();
    process.exit(1);
  }
}

main();
