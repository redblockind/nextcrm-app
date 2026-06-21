# Amazon Connect CSV → NextCRM Contact Mapping
**For: Historical Contact Import (CSV Only)**

Generated: April 28, 2026  
Status: Ready for Review

---

## Field Mapping Table

| CSV Field | NextCRM Target | Transformation Logic | Notes |
|-----------|-----------------|-------------------|-------|
| **FirstName** | `first_name` | Use as-is | Populated directly |
| **LastName** | `last_name` | Use as-is; if empty, use **email address as fallback** | Required field in NextCRM; fallback ensures every contact has a value |
| **PersonalEmailAddress** | `email` | Use as-is (despite field name, contains actual email) | Primary contact info; used for deduplication |
| **Attributes.B2BDiscountPercent** | `notes[]` | Append: `"B2BDiscountPercent: {value}"` | Only if populated |
| **Attributes.City** | `description` or parse to address | If full address parsing attempted: use as city component | Store as description if no address parsing |
| **Attributes.ConfirmTime** | `notes[]` | Append: `"ConfirmTime: {ISO-8601-datetime}"` | Confirmation timestamp |
| **Attributes.ContactOrigin** | `notes[]` | Append: `"ContactOrigin: {value}"` | Track source of contact (Stripe, Netlify, etc.) |
| **Attributes.Country** | Part of address or `notes[]` | If address parsing: use as country; otherwise append: `"Country: {value}"` | May be 2-letter code or full name |
| **Attributes.CumulativeOrderCount** | `notes[]` | Append: `"CumulativeOrderCount: {value}"` | Historical purchase count |
| **Attributes.FirstOrderDate** | `notes[]` | Append: `"FirstOrderDate: {ISO-8601-date}"` | First purchase date |
| **Attributes.GuestStripeName** | Internal reference | Store in `notes[]` as `"GuestStripeName: {value}"` | Stripe guest identifier |
| **Attributes.IsB2B** | `notes[]` | Append: `"IsB2B: {true/false}"` | B2B classification flag |
| **Attributes.IsTemporary** | `notes[]` | Append: `"IsTemporary: {true/false}"` | Marks temporary/test contacts |
| **Attributes.LastOrderDate** | `notes[]` | Append: `"LastOrderDate: {ISO-8601-date}"` | Most recent purchase date |
| **Attributes.LastOrderId** | `notes[]` | Append: `"LastOrderId: {value}"` | Reference to last order |
| **Attributes.MailchimpDateCreated** | `notes[]` | Append: `"MailListDateCreated: {ISO-8601-datetime}"` | Email list signup date (special formatting per requirements) |
| **Attributes.MailchimpFullName** | `first_name` + `last_name` | **Parse logic**: Split on space (first word = first_name, rest = last_name); only populate if existing first_name/last_name are empty | Enrichment/correction field; use only as fallback |
| **Attributes.MailchimpStreetAddress** | Address fields or `notes[]` | **Intelligent parsing**: Attempt to extract City, State/Province, PostalCode, Country from mixed text; if parsing fails, store as-is in `notes[]`: `"MailchimpStreetAddress: {full-text}"` | Unpredictable format; parse best-effort |
| **Attributes.MailchimpTags** | `tags[]` | Parse array and add directly as-is | Each tag becomes array element (e.g., `["newsletter-2026", "blog-signup"]`) |
| **Attributes.OptInTime** | `notes[]` | Append: `"OptInTime: {ISO-8601-datetime}"` | When contact opted in |
| **Attributes.State** | Part of address or `notes[]` | If address parsing: use as state; otherwise append: `"State: {value}"` | 2-letter abbreviation (US states) or province name |
| **Attributes.StripeCreateDate** | `created_on` | Use as contact creation date if available | Preserves original Stripe signup date |
| **Attributes.StripeCustomerId** | `notes[]` | Append: `"StripeCustomerId: {value}"` | Stripe customer reference ID |
| **Attributes.StripeName** | `first_name` + `last_name` | **Parse logic**: Split on space (first word = first_name, rest = last_name); only populate if existing first_name/last_name are empty | Enrichment/correction field; use only as fallback |

---

## Derived Fields (Automatically Set)

| NextCRM Field | Source/Logic | Notes |
|---|---|---|
| `email` (dedup check) | CSV: **PersonalEmailAddress** | Before creating contact, search `crm_search_contacts(email: value)` to prevent duplicates |
| `status` | Default: `true` | All imported contacts marked as Active unless flagged with `IsTemporary: true` |
| `tags[]` | CSV: **Attributes.MailchimpTags** + implicit tag | Always add `"imported-from-amazon-connect"` to tags for import tracking |
| `notes[]` | Multiple fields (see "Appended Notes" section below) | Array of structured note entries |
| `created_on` | CSV: **Attributes.StripeCreateDate** or auto | Preserves original contact creation date when available |

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
3. Attributes.StripeName (if primary and Mailchimp are empty)

Parsing: "John Doe" → first_name="John", last_name="Doe"
```

### Rule 3: Address Parsing (Best-Effort)
```
Attributes.MailchimpStreetAddress contains mixed text:
- Attempt to identify City, State, PostalCode, Country
- If parsing succeeds: populate address fields
- If parsing fails or unclear: store full text in notes as "MailchimpStreetAddress: {text}"

Examples:
"Oakland Park FL 33334 US" → City="Oakland Park", State="FL", PostalCode="33334", Country="US"
"Vancouver British Columbia CA" → City="Vancouver", State="BC", Country="CA"
"Riga" → City="Riga" (incomplete; store as-is)
```

### Rule 4: Phone Fields
```
CSV export has no phone fields in the desired list.
SKIP phone mapping entirely for CSV import.
```

### Rule 5: Contact Type
```
CSV export has no contact_type_id data.
Leave contact_type_id empty (contacts will have no type on creation).
Can be assigned post-import or via enrichment.
```

---

## Appended Notes (notes[] array)

The `notes[]` field will be an array of formatted strings. Each entry uses format: `"FieldName: value"`

### Example notes array for a single contact:
```json
[
  "ContactOrigin: Stripe",
  "StripeCustomerId: cus_UOhrTYdq5vamCi",
  "B2BDiscountPercent: 20",
  "IsB2B: true",
  "FirstOrderDate: 2026-01-29",
  "LastOrderDate: 2026-01-30",
  "MailListDateCreated: 2026-04-25T00:55:15.821Z",
  "OptInTime: 2026-04-25T00:55:15.821Z"
]
```

### Note: MailchimpDateCreated Special Case
Per requirements, format as: `"MailListDateCreated: {ISO-8601-datetime}"`  
(NOT `MailchimpDateCreated`)

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
| Mailchimp street address unparseable | Store full text in notes; don't fail import |
| Missing fields marked as required | Log warning but continue (NextCRM allows nulls for most fields) |

---

## Import Workflow Summary

```
FOR EACH row in CSV:
  1. Extract FirstName, LastName, PersonalEmailAddress
  2. Deduplicate: crm_search_contacts(email)
     IF duplicate exists → SKIP & log
  3. Enrich names: Use Mailchimp/Stripe name if primary names missing
  4. Parse address: Attempt intelligent extraction from MailchimpStreetAddress
  5. Collect notes: Build notes[] array from Attributes.*
  6. Collect tags: Parse MailchimpTags; add "imported-from-amazon-connect"
  7. Set created_on: Use StripeCreateDate if available
  8. Call crm_create_contact(data)
  9. Log success/error
  10. Continue to next row
```

---

## Data Quality Expectations

- **Email coverage**: ~95% of records have email
- **Name coverage**: ~70% have first+last name; remaining can use email fallback
- **Address coverage**: ~30% have Mailchimp street address; many unparseable
- **Tags**: ~50% have Mailchimp tags
- **Stripe reference**: ~80% have StripeCustomerId or related fields

---

## CSV Columns to Include (in order)

For the actual import, ensure CSV includes (at minimum):

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

## Next Steps

1. **Review this mapping** — Confirm parsing logic matches expectations
2. **Prepare subset CSV** — Use 10-20 test records
3. **Build import script** — Implement mapping logic (Node.js with CSV parser)
4. **Run test import** — Check NextCRM for correct mappings
5. **Review results** — Verify field values, notes array, tags
6. **Full import** — Run on complete 1000-contact dataset once test passes

---

**End of Mapping Document**
