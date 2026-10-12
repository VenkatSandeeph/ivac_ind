// Test script to verify Supabase event logging works.
// Run with: node scripts/test-supabase-logging.mjs
//
// This uses the SAME hardcoded credentials and table logic as src/supabase.ts
// so it accurately reflects what the running app would do.

import os from 'os';
import { createClient } from '@supabase/supabase-js';

const HARD_CODED_SUPABASE_URL = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';
const HARD_CODED_SUPABASE_KEY = 'sb_publishable_BpwV8vJS8RkVAlgayjlK1g_JSED4oLE';
const TABLE = 'events';

const EVENT_TYPE = 'logging_test';
const PAYLOAD = {
  source: 'test-supabase-logging.mjs',
  message: 'connectivity test from test script',
  timestamp: new Date().toISOString(),
  pid: process.pid
};

async function main() {
  console.log('=== Supabase Logging Test ===');
  console.log('URL:   ', HARD_CODED_SUPABASE_URL);
  console.log('Table: ', TABLE);
  console.log('Event: ', EVENT_TYPE);
  console.log('Host:  ', os.hostname());
  console.log('');

  // 1) Connectivity check: can we SELECT from the events table at all?
  console.log('Step 1: SELECT connectivity check...');
  const client = createClient(HARD_CODED_SUPABASE_URL, HARD_CODED_SUPABASE_KEY);

  try {
    const { data: selData, error: selError } = await client
      .from(TABLE)
      .select('id, event_type, created_at')
      .order('created_at', { ascending: false })
      .limit(3);

    if (selError) {
      console.log('  SELECT error:', JSON.stringify(selError, null, 2));
      console.log('  -> The anon key cannot read the events table. RLS SELECT policy may be missing.');
    } else {
      console.log('  SELECT ok. Recent rows:');
      if (selData && selData.length > 0) {
        for (const row of selData) {
          console.log('   -', row.id, row.event_type, row.created_at);
        }
      } else {
        console.log('   (table is empty or returned no rows)');
      }
    }
  } catch (e) {
    console.log('  SELECT threw:', e?.message || e);
  }

  console.log('');

  // 2) INSERT test: try to insert a logging_test event
  console.log('Step 2: INSERT test event...');
  const record = {
    event_type: EVENT_TYPE,
    payload: PAYLOAD,
    system: os.hostname(),
    created_at: new Date().toISOString()
  };

  try {
    const { data: insData, error: insError } = await client
      .from(TABLE)
      .insert([record])
      .select();

    if (insError) {
      console.log('  INSERT error:', JSON.stringify(insError, null, 2));
      console.log('  -> Logging is NOT working. The anon key cannot insert into the events table.');
      console.log('     Likely cause: RLS INSERT policy missing for anon role on public.events.');
      process.exitCode = 1;
      return;
    }

    console.log('  INSERT ok. Returned row(s):');
    if (insData && insData.length > 0) {
      for (const row of insData) {
        console.log('   -', row.id, row.event_type, row.created_at);
      }
    } else {
      console.log('   (insert succeeded but no row returned - check the table in Supabase dashboard)');
    }
    console.log('');
    console.log('=== Supabase logging is WORKING ===');
  } catch (e) {
    console.log('  INSERT threw:', e?.message || e);
    console.log('  -> Logging is NOT working due to a thrown error.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Test script failed:', e);
  process.exitCode = 1;
});
