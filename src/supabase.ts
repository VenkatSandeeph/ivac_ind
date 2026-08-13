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

export async function sendSupabaseEvent(eventType: string, payload: Record<string, any>) {
  const c = initClientIfNeeded();
  if (!c) return false;
  const record = {
    event_type: eventType,
    payload: payload || {},
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

export default sendSupabaseEvent;
