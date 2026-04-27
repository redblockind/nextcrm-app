-- AlterTable: add company details to Invoice_Settings
ALTER TABLE "Invoice_Settings"
  ADD COLUMN IF NOT EXISTS "companyName"    TEXT,
  ADD COLUMN IF NOT EXISTS "companyAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "companyCity"    TEXT,
  ADD COLUMN IF NOT EXISTS "companyZip"     TEXT,
  ADD COLUMN IF NOT EXISTS "companyCountry" TEXT,
  ADD COLUMN IF NOT EXISTS "companyVatId"   TEXT,
  ADD COLUMN IF NOT EXISTS "companyTaxId"   TEXT,
  ADD COLUMN IF NOT EXISTS "companyRegNo"   TEXT,
  ADD COLUMN IF NOT EXISTS "companyEmail"   TEXT,
  ADD COLUMN IF NOT EXISTS "companyPhone"   TEXT,
  ADD COLUMN IF NOT EXISTS "companyWebsite" TEXT;
