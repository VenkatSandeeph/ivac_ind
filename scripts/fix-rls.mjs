// Fix RLS policies for the Licenses table
// Requires SUPABASE_SERVICE_ROLE_KEY env var

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const SUPABASE_URL = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function runSQL(sql) {
  console.log('Running SQL:', sql.substring(0, 80) + '...');
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/', {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });
  console.log('  RPC status:', res.status);
}

// Check if RLS is enabled
async function checkTable() {
  // Query with anon key
  const anonKey = 'sb_publishable_BpwV8vJS8RkVAlgayjlK1g_JSED4oLE';
  
  console.log('=== Testing with anon key ===');
  const res1 = await fetch(SUPABASE_URL + '/rest/v1/Licenses?select=*&limit=1', {
    headers: {
      'apikey': anonKey,
      'Authorization': 'Bearer ' + anonKey
    }
  });
  const data1 = await res1.json();
  console.log('Anon SELECT result:', res1.status, JSON.stringify(data1));

  console.log('\n=== Testing with service_role key ===');
  const res2 = await fetch(SUPABASE_URL + '/rest/v1/Licenses?select=*&limit=1', {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY
    }
  });
  const data2 = await res2.json();
  console.log('Service role SELECT result:', res2.status, JSON.stringify(data2));

  if (data1.length === 0 && data2.length > 0) {
    console.log('\n*** PROBLEM: Anon key cannot read the table. RLS SELECT policy is missing for anon role. ***');
    console.log('\nPlease run this SQL in the Supabase SQL Editor:');
    console.log('');
    console.log('  -- Enable RLS if not already');
    console.log('  ALTER TABLE public."Licenses" ENABLE ROW LEVEL SECURITY;');
    console.log('');
    console.log('  -- Allow anon to SELECT');
    console.log('  CREATE POLICY "anon_read" ON public."Licenses" FOR SELECT TO anon USING (true);');
    console.log('');
    console.log('  -- Allow anon to UPDATE (for system_name and last_validated_at)');
    console.log('  CREATE POLICY "anon_update" ON public."Licenses" FOR UPDATE TO anon USING (true) WITH CHECK (true);');
    console.log('');
  } else if (data1.length > 0) {
    console.log('\nAnon key CAN read. RLS is fine!');
  }
}

checkTable().catch(e => console.error('Error:', e.message));
