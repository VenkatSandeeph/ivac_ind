import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const dedupDir = path.resolve(process.cwd(), 'artifacts', 'state');
const dedupPath = path.join(dedupDir, 'login-sent.json');

type DedupFile = {
  entries: Record<string, { username: string; machineId: string; firstSentAt: string }>;
};

/**
 * Stable identifier for the current machine + OS user. Not PII-safe by itself
 * (contains hostname + os username), so we hash it before storing/sending.
 */
export function getMachineId(): string {
  const raw = `${os.hostname()}::${os.userInfo().username}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function keyFor(username: string, machineId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${username.toLowerCase()}::${machineId}`)
    .digest('hex')
    .slice(0, 32);
}

function loadDedup(): DedupFile {
  if (!fs.existsSync(dedupPath)) return { entries: {} };
  try {
    const raw = fs.readFileSync(dedupPath, 'utf8');
    const parsed = JSON.parse(raw) as DedupFile;
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function saveDedup(data: DedupFile) {
  fs.mkdirSync(dedupDir, { recursive: true });
  fs.writeFileSync(dedupPath, JSON.stringify(data, null, 2), 'utf8');
}

export function hasLoginEventBeenSent(username: string, machineId: string): boolean {
  const data = loadDedup();
  return !!data.entries[keyFor(username, machineId)];
}

export function markLoginEventSent(username: string, machineId: string): void {
  const data = loadDedup();
  data.entries[keyFor(username, machineId)] = {
    username,
    machineId,
    firstSentAt: new Date().toISOString()
  };
  saveDedup(data);
}
