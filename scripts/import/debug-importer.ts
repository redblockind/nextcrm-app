import fs from 'fs';

const csvFilePath = 'scripts/import/test-contacts.csv';
const content = fs.readFileSync(csvFilePath, 'utf-8');
const lines = content.split('\n').filter((line) => line.trim());

console.log(`📊 Analyzing CSV file: ${csvFilePath}\n`);
console.log(`Total lines: ${lines.length}`);
console.log(`Header length: ${lines[0].length} chars\n`);

// Parse header
const headerLine = lines[0];
const headers = headerLine.split(',');

console.log(`✓ Found ${headers.length} columns\n`);
console.log('Key columns:');
console.log(`  FirstName (col 6): "${headers[6]}"`);
console.log(`  LastName (col 8): "${headers[8]}"`);
console.log(`  PersonalEmailAddress (col 16): "${headers[16]}"`);
console.log(`  Attributes.City (col 62): "${headers[62]}"`);
console.log(`  Attributes.State (col 80): "${headers[80]}"`);
console.log(`  Attributes.Country (col 65): "${headers[65]}"`);
console.log(`  Attributes.StripeCustomerId (col 82): "${headers[82]}"`);
console.log(`  Attributes.ContactOrigin (col 64): "${headers[64]}"\n`);

// Parse first data row
const firstRow = lines[1];
const values = firstRow.split(',');

console.log(`✓ First data row has ${values.length} columns\n`);
console.log('First contact data:');
console.log(`  FirstName (col 6): "${values[6]}"`);
console.log(`  LastName (col 8): "${values[8]}"`);
console.log(`  PersonalEmailAddress (col 16): "${values[16]}"`);
console.log(`  Attributes.City (col 62): "${values[62]}"`);
console.log(`  Attributes.State (col 80): "${values[80]}"`);
console.log(`  Attributes.Country (col 65): "${values[65]}"`);
console.log(`  Attributes.StripeCustomerId (col 82): "${values[82]}"`);
console.log(`  Attributes.ContactOrigin (col 64): "${values[64]}"\n`);

// Try header-based lookup (what the script does)
console.log('Header-based lookup:');
const row: Record<string, string> = {};
headers.forEach((header, index) => {
  row[header.trim()] = values[index] || '';
});

console.log(`  FirstName: "${row['FirstName']}"`);
console.log(`  LastName: "${row['LastName']}"`);
console.log(`  PersonalEmailAddress: "${row['PersonalEmailAddress']}"`);
console.log(`  Attributes.City: "${row['Attributes.City']}"`);
console.log(`  Attributes.State: "${row['Attributes.State']}"`);
console.log(`  Attributes.Country: "${row['Attributes.Country']}"`);
console.log(`  Attributes.StripeCustomerId: "${row['Attributes.StripeCustomerId']}"`);
console.log(`  Attributes.ContactOrigin: "${row['Attributes.ContactOrigin']}"`);
