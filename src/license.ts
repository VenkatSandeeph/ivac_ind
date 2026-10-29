/**
 * license.ts -- License validation against Supabase
 *
 * Used by both the Electron main process (ui/main.js via esbuild bundle)
 * and the core automation script (src/index.ts).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createClient } from '@supabase/supabase-js';

// Supabase project for licensing (publishable key — no direct table access;
// validation goes through the validate_license SECURITY DEFINER RPC)
const LICENSE_SUPABASE_URL = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';
const LICENSE_SUPABASE_KEY = 'sb_publishable_BpwV8vJS8RkVAlgayjlK1g_JSED4oLE';

export type LicenseRecord = {
  id: string;
  license_key: string;
  client_name: string;
  active: boolean;
  terminated: boolean;
  system_name: string | null;
  expires_at: string | null;
  last_validated_at: string | null;
  created_at: string;
  tg_chat_id: string | null;
};

export type LicenseResult = {
  valid: boolean;
  status: 'valid' | 'invalid_key' | 'deactivated' | 'terminated' | 'expired' | 'network_error';
  message: string;
  record?: LicenseRecord;
};

/** Get the system identifier: HOSTNAME\Username */
export function getSystemName(): string {
  const hostname = os.hostname();
  const username = os.userInfo().username;
  return `${hostname}\\${username}`;
}

/** Resolve the path to the .license file next to the executable */
export function getLicenseFilePath(): string {
  const root = typeof (process as any).pkg !== 'undefined'
    ? path.dirname(process.execPath)
    : process.cwd();
  return path.join(root, '.license');
}

/** Read the stored license key from disk */
export function readStoredLicenseKey(): string | null {
  try {
    const filePath = getLicenseFilePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    // Support both plain text and JSON format
    try {
      const parsed = JSON.parse(raw);
      return parsed.key || parsed.license_key || null;
    } catch {
      // Plain text key
      return raw;
    }
  } catch {
    return null;
  }
}

/** Store the license key to disk */
export function storeLicenseKey(key: string): void {
  const filePath = getLicenseFilePath();
  fs.writeFileSync(filePath, JSON.stringify({ key }, null, 2), 'utf8');
}

/** Remove the stored license key from disk */
export function clearStoredLicenseKey(): void {
  try {
    const filePath = getLicenseFilePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Validate a license key against Supabase.
 * On success, updates system_name and last_validated_at.
 */
export async function validateLicense(licenseKey: string): Promise<LicenseResult> {
  if (!licenseKey || !licenseKey.trim()) {
    return { valid: false, status: 'invalid_key', message: 'No license key provided.' };
  }

  const key = licenseKey.trim();

  const systemName = getSystemName();

  try {
    const client = createClient(LICENSE_SUPABASE_URL, LICENSE_SUPABASE_KEY);

    // validate_license is a SECURITY DEFINER RPC: the anon role has NO table
    // privileges on Licenses at all, so keys can never be listed — validation
    // returns the row only for the exact key supplied, and the system_name /
    // last_validated_at tracking update happens inside the function.
    const { data, error } = await client
      .rpc('validate_license', { p_key: key, p_system: systemName });

    const record = (data ?? null) as LicenseRecord | null;

    if (error) {
      return {
        valid: false,
        status: 'network_error',
        message: 'Failed to connect to license server: ' + (error.message || 'Unknown error')
      };
    }

    if (!record) {
      return { valid: false, status: 'invalid_key', message: 'Invalid license key.' };
    }

    // Check terminated
    if (record.terminated) {
      return {
        valid: false,
        status: 'terminated',
        message: 'This license has been terminated by the administrator.',
        record
      };
    }

    // Check active
    if (!record.active) {
      return {
        valid: false,
        status: 'deactivated',
        message: 'This license has been deactivated. Contact your administrator.',
        record
      };
    }

    // Check expiry
    if (record.expires_at) {
      const expiresAt = new Date(record.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        return {
          valid: false,
          status: 'expired',
          message: 'This license expired on ' + expiresAt.toLocaleDateString() + '.',
          record
        };
      }
    }

    // Tracking fields were already updated inside the RPC (anon has no UPDATE).

    return {
      valid: true,
      status: 'valid',
      message: 'License valid. Welcome, ' + record.client_name + '.',
      record: { ...record, system_name: systemName, last_validated_at: new Date().toISOString() }
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    // Handle TLS errors (corporate proxy)
    if (msg.includes('SELF_SIGNED_CERT') || msg.includes('certificate')) {
      return {
        valid: false,
        status: 'network_error',
        message: 'TLS certificate error connecting to license server. Check your network/proxy settings.'
      };
    }
    return {
      valid: false,
      status: 'network_error',
      message: 'Cannot reach license server: ' + msg
    };
  }
}
