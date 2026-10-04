/**
 * gen-license.mjs -- Generate and insert a license key into Supabase
 *
 * Usage:
 *   node scripts/gen-license.mjs <client_name> [--expires <YYYY-MM-DD>]
 *
 * Requires the SUPABASE_SERVICE_ROLE_KEY environment variable to be set
 * (the service_role key bypasses RLS and can INSERT).
 *
 * Example:
 *   set SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
 *   node scripts/gen-license.mjs "John Doe" --expires 2027-01-01
 */

import crypto from 'crypto';

const SUPABASE_URL = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';
const SUPABASE_TABLE = 'Licenses';

function generateLicenseKey() {
  // Format: IVAC-XXXX-XXXX-XXXX-XXXX (uppercase alphanumeric)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
  const segments = [];
  for (let s = 0; s < 4; s++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      seg += chars[crypto.randomInt(chars.length)];
    }
    segments.push(seg);
  }
  return 'IVAC-' + segments.join('-');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/gen-license.mjs <client_name> [--expires YYYY-MM-DD]');
    console.log('');
    console.log('Environment variables:');
    console.log('  SUPABASE_SERVICE_ROLE_KEY  (required) The service_role key from your Supabase project');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/gen-license.mjs "John Doe"');
    console.log('  node scripts/gen-license.mjs "Acme Corp" --expires 2027-06-30');
    process.exit(0);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is not set.');
    console.error('Get it from Supabase Dashboard -> Settings -> API -> service_role key');
    process.exit(1);
  }

  // Parse arguments
  let clientName = '';
  let expiresAt = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expires' && args[i + 1]) {
      expiresAt = args[i + 1];
      i++;
    } else if (!clientName) {
      clientName = args[i];
    }
  }

  if (!clientName) {
    console.error('ERROR: client_name is required.');
    process.exit(1);
  }

  const licenseKey = generateLicenseKey();
  const record = {
    license_key: licenseKey,
    client_name: clientName,
    active: true,
    terminated: false,
  };

  if (expiresAt) {
    record.expires_at = new Date(expiresAt).toISOString();
  }

  console.log('Inserting license...');
  console.log('  Client:', clientName);
  console.log('  Key:', licenseKey);
  if (expiresAt) console.log('  Expires:', expiresAt);

  // Use REST API directly (no need for supabase-js in scripts)
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(record)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('ERROR: Failed to insert license:', response.status, errorText);
    process.exit(1);
  }

  const inserted = await response.json();
  console.log('');
  console.log('License created successfully!');
  console.log('');
  console.log('  License Key:  ' + licenseKey);
  console.log('  Client Name:  ' + clientName);
  console.log('  ID:           ' + (inserted[0]?.id || 'N/A'));
  console.log('');
  console.log('Give the license key to the client. They enter it when launching the app.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
