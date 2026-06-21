# Amazon Connect CSV → NextCRM Contact Mapping (v2)
**For: Historical Contact Import (CSV Only) — With Custom Database Fields**

Generated: April 30, 2026  
Status: Ready for Review

---

## Overview

This mapping incorporates 13 new custom fields added to the `crm_Contacts` model via database migration. These fields directly correspond to Amazon Connect CSV attributes, enabling cleaner import without overloading the notes array.

---

## Field Mapping Table (Complete)

| CSV Field | NextCRM Target | Data Type | Transformation Logic | Notes |
|-----------|-----------------|-----------|-------------------|-------|
| **FirstName** | `first_name` | String | Use as-is; parse from other sources if empty | Populated directly from CSV |
| **LastName** | `last_name` | String | Use as-is; if empty, use **email address as fallback** | REQUIRED field; fallback ensures every contact has a value |
| **PersonalEmailAddress** | `email` | String | Use as-is (map all email variants to this single field) | Primary contact info; used for deduplication |
| **Attributes.B2BDiscountPercent** | `b2b_discount_percent` | String (text) | Use as-is | Preserve discount value as-received |
| **Attributes.City** | `city` | String | Use as-is; attempt parse from MailchimpStreetAddress if primary is missing | City/region data |
| **Attributes.ConfirmTime** | `notes[]` | Array | Append: `"ConfirmTime: {value}"` | Date/time when contact confirmed |
| **Attributes.ContactOrigin** | `contact_origin` | String | Use as-is (e.g., "Stripe", "Netlify", etc.) | **IMPORTANT**: Tracks source of contact |
| **Attributes.Country** | `country` | String | Use as-is; attempt parse from MailchimpStreetAddress if primary is missing | Country data |
| **Attributes.CumulativeOrderCount** | `cumulative_order_count` | String (text) | Use as-is | Historical purchase count |
| **Attributes.FirstOrderDate** | `first_order_date` | String (text) | Use as-is (keep date in original format) | First purchase date; stored as text |
| **Attributes.GuestStripeName** | Parse to first_name/last_name | String | **Parse logic**: Split on space; populate first_name/last_name only if not already set | Enrichment source |
| **Attributes.IsB2B** | `is_b2b` | Boolean | Convert to boolean: "true"/"false"/"TRUE"/"FALSE" → true/false | B2B classification flag |
| **Attributes.IsTemporary** | `is_temporary` | Boolean | Convert to boolean: "true"/"false"/"TRUE"/"FALSE" → true/false | Marks temporary/test contacts |
| **Attributes.LastOrderDate** | `last_order_date` | String (text) | Use as-is (keep date in original format) | Most recent purchase date; stored as text |
| **Attributes.LastOrderId** | `last_order_id` | String | Use as-is | Reference to last order ID |
| **Attributes.MailchimpDateCreated** | `notes[]` | Array | Append: `"MailListDateCreated: {value}"` | Email list signup date; stored as text |
| **Attributes.MailchimpFullName** | `first_name` + `last_name` | String | **Parse logic**: Split on space (first word = first_name, rest = last_name); only populate if existing first_name/last_name are empty | Enrichment/correction field; use only as fallback |
| **Attributes.MailchimpStreetAddress** | Parse to city, state, country or notes | String | **Intelligent parsing**: Attempt to extract City, State, PostalCode, Country from mixed text; if parsing fails, store as-is in `notes[]`: `"MailchimpStreetAddress: {full-text}"` | Unpredictable format; parse best-effort |
| **Attributes.MailchimpTags** | `tags[]` | Array | Parse array and add directly; also add implicit tag `"imported-from-amazon-connect"` | Each tag becomes array element |
| **Attributes.OptInTime** | `opt_in_time` | String (text) | Use as-is (keep in original format) | When contact opted in; stored as text |
| **Attributes.State** | `state` | String | Use as-is; attempt parse from MailchimpStreetAddress if primary is missing | State/province abbreviation or name |
| **Attributes.StripeCreateDate** | `first_order_date` | String (text) | Use as-is; preserved as legacy data in custom field | First order date stored separately; `created_on` will auto-populate with import date |
| **Attributes.StripeCustomerId** | `stripe_customer_id` | String | Use as-is | Stripe customer reference ID |
| **Attributes.StripeName** | `first_name` + `last_name` | String | **Parse logic**: Split on space (first word = first_name, rest = last_name); only populate if existing first_name/last_name are empty | Enrichment/correction field; use only as fallback |

---

## Derived & Auto-Set Fields

| NextCRM Field | Source/Logic | Notes |
|---|---|---|
| `email` (dedup check) | CSV: **PersonalEmailAddress** | Before creating contact, search `crm_search_contacts(email: value)` to prevent duplicates |
| `status` | Default: `true` | All imported contacts marked as Active unless flagged with `is_temporary: true` |
| `tags[]` | CSV: **Attributes.MailchimpTags** + implicit tag | Always add `"imported-from-amazon-connect"` to tags for import tracking |
| `notes[]` | Multiple fields (see "Appended Notes" section below) | Array of structured note entries for unmapped date/time fields |
| `created_on` | Auto-populated | Set to import date (today); all records have same creation date for clean tracking |

---

## New Custom Fields (Database Schema)

The following fields were **added to the Contact model** via migration and are now available for direct mapping:

| Field Name | DB Column | Type | Nullable | Purpose |
|---|---|---|---|---|
| City | `city` | String | Yes | Contact's city/region |
| Country | `country` | String | Yes | Contact's country |
| State | `state` | String | Yes | Contact's state/province |
| Is B2B | `is_b2b` | Boolean | Yes | Business-to-business flag |
| B2B Discount Percent | `b2b_discount_percent` | String | Yes | B2B discount percentage |
| Contact Origin | `contact_origin` | String | Yes | Source of contact (Stripe, Netlify, etc.) |
| Cumulative Order Count | `cumulative_order_count` | String | Yes | Total number of orders |
| First Order Date | `first_order_date` | String | Yes | Date of first order (text format) |
| Is Temporary | `is_temporary` | Boolean | Yes | Temporary/test contact flag |
| Last Order Date | `last_order_date` | String | Yes | Date of most recent order (text format) |
| Last Order ID | `last_order_id` | String | Yes | ID of most recent order |
| Opt In Time | `opt_in_time` | String | Yes | When contact opted in (text format) |
| Stripe Customer ID | `stripe_customer_id` | String | Yes | Stripe customer reference |

---

## Fallback & Parsing Rules

### Rule 1: Last Name (Required Field)
```
IF LastName is populated:
  USE LastName
ELSE IF PersonalEmailAddress is populated:
  USE PersonalEmailAddress (as fallback; ensures last_name is never null)
ELSE:
  SKIP this contact (log as error: missing required identifiers)
```

### Rule 2: First Name & Last Name Enrichment
```
Attempt to populate from (in order of priority):
1. CSV FirstName / LastName (primary)
2. Attributes.MailchimpFullName (if primary is empty)
3. Attributes.GuestStripeName (if primary and Mailchimp are empty)
4. Attributes.StripeName (if all above are empty)

Parsing: "John Doe" → first_name="John", last_name="Doe"
```

### Rule 3: Address Parsing (City/Country/State — Best-Effort)
```
Primary sources (direct CSV fields):
- Attributes.City → city
- Attributes.Country → country
- Attributes.State → state

Fallback source (if primary is missing):
- Parse Attributes.MailchimpStreetAddress for address components
  - Example: "Oakland Park FL 33334 US" → City="Oakland Park", State="FL", Country="US"
  - Example: "Vancouver British Columbia CA" → City="Vancouver", State="BC", Country="CA"
  - If parsing unclear: store full text in notes as "MailchimpStreetAddress: {text}"
```

### Rule 4: Boolean Fields (IsB2B, IsTemporary)
```
Convert to boolean:
- "true", "True", "TRUE", "1", "yes" → true
- "false", "False", "FALSE", "0", "no" → false
- Empty/null → null (optional field)
- Invalid value → log warning, set to null
```

### Rule 5: Date/Time Fields (Keep as Text)
Per requirements, all date/time fields are stored as text strings:
- `first_order_date` — Text (original format preserved)
- `last_order_date` — Text (original format preserved)
- `opt_in_time` — Text (original format preserved)
- `created_on` — DateTime (Prisma will handle conversion)

### Rule 6: Phone Fields
```
CSV export has no phone fields in the desired list.
SKIP phone mapping entirely for CSV import.
```

### Rule 7: Contact Type
```
CSV export has no contact_type_id data.
Leave contact_type_id empty (contacts will have no type on creation).
Can be assigned post-import or via enrichment.
```

---

## Appended Notes (notes[] array)

The `notes[]` field will be an array of formatted strings. Only fields without direct NextCRM mapping go here.

### Fields that go into notes[]:
- `ConfirmTime` — When contact confirmed
- `MailListDateCreated` — Email list creation date
- `MailchimpStreetAddress` — (if parsing fails)

### Example notes array for a single contact:
```json
[
  "ConfirmTime: 2026-04-25T00:55:15.821Z",
  "MailListDateCreated: 2026-04-25T00:55:15.821Z",
  "MailchimpStreetAddress: Oakland Park FL 33334 US"
]
```

---

## Deduplication Strategy

**Before creating each contact:**

1. Extract `email` from **PersonalEmailAddress**
2. Call `crm_search_contacts(email: {email})`
3. If match found:
   - Log as duplicate
   - Skip contact (do NOT overwrite existing record)
   - Record duplicate in error log for manual review
4. If no match:
   - Proceed with contact creation
   - Add `"imported-from-amazon-connect"` tag

---

## Tags Array Processing

**Input**: `Attributes.MailchimpTags` is a string like: `"newsletter-2026" "blog-signup"`

**Processing**:
1. Split on double-quotes or comma separator (auto-detect)
2. Create array: `["newsletter-2026", "blog-signup"]`
3. **Add implicit tag**: Always append `"imported-from-amazon-connect"`
4. **Result**: `["newsletter-2026", "blog-signup", "imported-from-amazon-connect"]`

---

## Import Error Handling

| Condition | Action |
|-----------|--------|
| Missing both `FirstName` and `LastName` | Attempt email-based fallback for `last_name`; if email also missing, skip contact and log error |
| Invalid email format | Attempt to correct/parse; if unparseable, store email as-is and log warning |
| Duplicate email found | Skip; log as duplicate for manual review |
| Boolean field has invalid value | Log warning; set field to null |
| Date/time field unparseable | Store as-is in text field; log warning (don't fail) |
| Mailchimp street address unparseable | Store full text in notes; don't fail import |
| Missing fields marked as required | Log warning but continue (NextCRM allows nulls for most fields) |

---

## Import Workflow Summary

```
FOR EACH row in CSV:
  1. Extract FirstName, LastName, PersonalEmailAddress
  2. Deduplicate: crm_search_contacts(email)
     IF duplicate exists → SKIP & log
  
  3. Enrich names: Use Mailchimp/Stripe/Guest name if primary names missing
  
  4. Parse address: Attempt intelligent extraction of City/State/Country
     - Primary: use Attributes.City, Attributes.Country, Attributes.State
     - Fallback: parse MailchimpStreetAddress for missing components
  
  5. Convert booleans: IsB2B, IsTemporary
  
  6. Collect notes: Build notes[] array from ConfirmTime, MailchimpDateCreated, etc.
  
  7. Collect tags: Parse MailchimpTags; add "imported-from-amazon-connect"
  
  8. Skip timestamp mapping: Let created_on auto-populate with today's date
  
  9. Populate custom fields:
     - b2b_discount_percent
     - contact_origin
     - cumulative_order_count
     - first_order_date (text)
     - is_temporary
     - last_order_date (text)
     - last_order_id
     - opt_in_time (text)
     - stripe_customer_id
  
  10. Call crm_create_contact(data)
  
  11. Log success/error
  
  12. Continue to next row
```

---

## Data Quality Expectations

- **Email coverage**: ~95% of records have email
- **Name coverage**: ~70% have first+last name; remaining can use email fallback
- **Address coverage**: ~30% have Mailchimp street address; many unparseable
- **Tags**: ~50% have Mailchimp tags
- **Stripe reference**: ~80% have StripeCustomerId or related fields
- **B2B flags**: ~40% have IsB2B flag
- **Date fields**: ~60% have order/activity dates

---

## CSV Columns to Include (at minimum)

For the actual import, ensure CSV includes these columns:

```
FirstName,
LastName,
PersonalEmailAddress,
Attributes.B2BDiscountPercent,
Attributes.City,
Attributes.ConfirmTime,
Attributes.ContactOrigin,
Attributes.Country,
Attributes.CumulativeOrderCount,
Attributes.FirstOrderDate,
Attributes.GuestStripeName,
Attributes.IsB2B,
Attributes.IsTemporary,
Attributes.LastOrderDate,
Attributes.LastOrderId,
Attributes.MailchimpDateCreated,
Attributes.MailchimpFullName,
Attributes.MailchimpStreetAddress,
Attributes.MailchimpTags,
Attributes.OptInTime,
Attributes.State,
Attributes.StripeCreateDate,
Attributes.StripeCustomerId,
Attributes.StripeName
```

---

## Migration Information

**Migration Name**: `add_amazon_connect_import_fields`  
**Date**: 2026-04-30  
**Changes**: Added 13 new columns to `crm_Contacts` table

**Columns Added**:
- `city` (TEXT)
- `country` (TEXT)
- `state` (TEXT)
- `is_b2b` (BOOLEAN)
- `b2b_discount_percent` (TEXT)
- `contact_origin` (TEXT)
- `cumulative_order_count` (TEXT)
- `first_order_date` (TEXT)
- `is_temporary` (BOOLEAN)
- `last_order_date` (TEXT)
- `last_order_id` (TEXT)
- `opt_in_time` (TEXT)
- `stripe_customer_id` (TEXT)

**To Apply Migration**:
```bash
npx prisma migrate dev --name add_amazon_connect_import_fields
```

Or manually:
```bash
npx prisma db push
```

---

## Next Steps

1. **Review this mapping** — Confirm parsing logic and field assignments
2. **Apply database migration** — Run the migration command above
3. **Prepare subset CSV** — Use 10-20 test records
4. **Build import script** — Implement mapping logic (Node.js with CSV parser)
5. **Run test import** — Check NextCRM for correct mappings
6. **Review results** — Verify field values, notes array, tags, custom fields
7. **Full import** — Run on complete 1000-contact dataset once test passes

---

**End of Mapping Document (v2)**
