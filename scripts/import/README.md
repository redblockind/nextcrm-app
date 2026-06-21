# Amazon Connect CSV Contact Importer

This directory contains the script for importing contacts from Amazon Connect CSV exports into NextCRM.

## Quick Start

1. **Place your CSV file** in this directory:
   ```
   scripts/import/test-contacts.csv
   ```

2. **Run the importer** from the project root:
   ```bash
   npx ts-node scripts/import/crm-contact-importer.ts scripts/import/test-contacts.csv
   ```

3. **Review the results** — The script prints a summary with success/error counts

## CSV Format

The importer expects these columns from Amazon Connect export:

- `FirstName`
- `LastName`
- `PersonalEmailAddress`
- `Attributes.B2BDiscountPercent`
- `Attributes.City`
- `Attributes.ConfirmTime`
- `Attributes.ContactOrigin`
- `Attributes.Country`
- `Attributes.CumulativeOrderCount`
- `Attributes.FirstOrderDate`
- `Attributes.GuestStripeName`
- `Attributes.IsB2B`
- `Attributes.IsTemporary`
- `Attributes.LastOrderDate`
- `Attributes.LastOrderId`
- `Attributes.MailchimpDateCreated`
- `Attributes.MailchimpFullName`
- `Attributes.MailchimpStreetAddress`
- `Attributes.MailchimpTags`
- `Attributes.OptInTime`
- `Attributes.State`
- `Attributes.StripeCreateDate`
- `Attributes.StripeCustomerId`
- `Attributes.StripeName`

## Features

✓ **Deduplication** — Checks for duplicate emails before creating  
✓ **Name enrichment** — Parses multiple name sources if primary is empty  
✓ **Address parsing** — Intelligently extracts city/state/country  
✓ **Tag processing** — Parses Mailchimp tags and adds import tracking  
✓ **Error handling** — Logs errors without stopping the import  
✓ **Detailed reporting** — Summary with success/error/duplicate counts  

## Field Mapping

See `CSV_IMPORT_MAPPING_UPDATED.md` in the project root for complete field mapping documentation.

## Examples

**Test with small subset:**
```bash
npx ts-node scripts/import/crm-contact-importer.ts scripts/import/test-contacts.csv
```

**Full import (1000+ contacts):**
```bash
npx ts-node scripts/import/crm-contact-importer.ts scripts/import/all-contacts.csv
```

## Privacy & Security

**⚠️ Important**: CSV files containing customer data are **NOT committed to git** (excluded in `.gitignore`). 

Keep your CSV files locally only. Never push them to the repository.

## Troubleshooting

**"CSV file not found"**
- Verify the file path is correct
- File should be in `scripts/import/` directory

**"Missing required fields"**
- Contact must have at least a `LastName` (or email to use as fallback)
- Check that your CSV has the required columns

**Duplicate errors**
- If a contact with that email already exists, it's skipped
- Check the error log for details

## Support

Refer to `CSV_IMPORT_MAPPING_UPDATED.md` for detailed mapping rules and field transformations.
