import fs from 'fs';
import path from 'path';
import os from 'os';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { warn, info } from './logger';

// Intentionally hard-coded credentials.
const HARD_CODED_SUPABASE_URL: string = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';
const HARD_CODED_SUPABASE_KEY: string = 'sb_publishable_BpwV8vJS8RkVAlgayjlK1g_JSED4oLE';

let client: SupabaseClient | null = null;

function loadLocalSupabaseConfig() {
  const cfgPath = path.resolve(process.cwd(), 'config.local.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.supabase || {};
  } catch (e) {
    return {};
  }
}

function initClientIfNeeded() {
  if (client) return client;
  const local = loadLocalSupabaseConfig();

  const url = HARD_CODED_SUPABASE_URL || process.env.SUPABASE_URL || local.url || '';
  const key = HARD_CODED_SUPABASE_KEY || process.env.SUPABASE_KEY || local.key || '';

  if (!url || !key || key === 'REPLACE_WITH_YOUR_SUPABASE_KEY') {
    warn('Supabase URL or Key not configured; event logging disabled');
    return null;
  }

  try {
    client = createClient(url, key);
    return client;
  } catch (e) {
    warn('Failed to create Supabase client:', e);
    return null;
  }
}

// Keys that must NEVER leave the machine in telemetry. Checked recursively so
// a nested payload can't smuggle them through — e.g. submit_clicked used to
// embed config.password verbatim, and login events carried the full
// securityQuestions array (all publicly readable before RLS was tightened).
const SECRET_PAYLOAD_KEYS = new Set([
  'password', 'passwd', 'securityquestions', 'securityquestion',
  'securityanswer', 'securityanswers', 'answer', 'secret'
]);

function sanitizePayload(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_PAYLOAD_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitizePayload(v);
    }
    return out;
  }
  return value;
}

export async function sendSupabaseEvent(eventType: string, payload: Record<string, any>) {
  const c = initClientIfNeeded();
  if (!c) return false;
  const record = {
    event_type: eventType,
    payload: sanitizePayload(payload || {}),
    system: os.hostname(),
    created_at: new Date().toISOString()
  };

  try {
    const table = process.env.SUPABASE_EVENT_TABLE || (loadLocalSupabaseConfig().table || 'events');
    const res = await c.from(table).insert([record]);
    // supabase-js v2 returns { data, error }
    // @ts-ignore
    if (res?.error) {
      warn('Supabase insert error:', res.error);
      return false;
    }
    info('Supabase event sent:', eventType);
    return true;
  } catch (e) {
    warn('Failed to send supabase event:', e);
    return false;
  }
}

/**
 * Upserts a login_submitted event: if an existing login_submitted row matches
 * the same username + system (hostname), updates its timestamp and payload
 * instead of inserting a duplicate. Falls back to insert if the query fails.
 *
 * This prevents the Supabase events table from accumulating duplicate login
 * rows for the same user on the same machine across multiple runs.
 */
export async function upsertLoginEvent(payload: Record<string, any>): Promise<boolean> {
  const c = initClientIfNeeded();
  if (!c) return false;

  const table = process.env.SUPABASE_EVENT_TABLE || (loadLocalSupabaseConfig().table || 'events');
  const clean = sanitizePayload(payload || {});
  const username = String(clean?.username || '');
  const system = os.hostname();

  // Preferred path: security-definer RPC does the dedup select+update
  // server-side — anon no longer has SELECT/UPDATE on the events table.
  // Falls back to the legacy client-side flow if the RPC isn't deployed yet.
  if (table === 'events') {
    try {
      const { error } = await c.rpc('upsert_login_event', {
        p_username: username,
        p_system: system,
        p_payload: clean
      });
      if (!error) {
        info('Supabase login event upserted via RPC (user=' + username + ' system=' + system + ')');
        return true;
      }
      warn('upsert_login_event RPC failed (falling back to insert):', error);
      return sendSupabaseEvent('login_submitted', clean);
    } catch (e) {
      warn('upsert_login_event RPC threw (falling back to insert):', e);
      return sendSupabaseEvent('login_submitted', clean);
    }
  }

  try {
    // Query for an existing login_submitted event for this user + system
    const { data, error } = await c
      .from(table)
      .select('id')
      .eq('event_type', 'login_submitted')
      .eq('system', system)
      .filter('payload->>username', 'eq', username)
      .limit(1);

    if (error) {
      warn('Supabase query error in upsertLoginEvent (falling back to insert):', error);
      return sendSupabaseEvent('login_submitted', clean);
    }

    if (data && data.length > 0) {
      // Update existing row's timestamp and payload
      const existingId = data[0].id;
      const { error: updateError } = await c
        .from(table)
        .update({
          payload: clean,
          created_at: new Date().toISOString()
        })
        .eq('id', existingId);

      if (updateError) {
        warn('Supabase update error in upsertLoginEvent:', updateError);
        return false;
      }
      info('Supabase login event updated (existing row for user=' + username + ' system=' + system + ')');
      return true;
    }

    // No existing row — insert new
    return sendSupabaseEvent('login_submitted', clean);
  } catch (e) {
    warn('Failed to upsert login event (falling back to insert):', e);
    return sendSupabaseEvent('login_submitted', clean);
  }
}

export default sendSupabaseEvent;
