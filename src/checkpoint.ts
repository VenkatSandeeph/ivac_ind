import fs from 'fs';
import path from 'path';

export type RuntimeCheckpoint = {
  runId: string;
  state: string;
  attempt: number;
  city?: string;
  url?: string;
  date?: string;
  time?: string;
  lastError?: string;
  timestamp: string;
};

function getProfileId(): string {
  return process.env.IVAC_PROFILE_ID || 'default';
}

function getCheckpointDir(): string {
  return path.resolve(process.cwd(), 'artifacts', 'state', getProfileId());
}

function getCheckpointPath(): string {
  return path.join(getCheckpointDir(), 'checkpoint.json');
}

export function loadCheckpoint(): RuntimeCheckpoint | null {
  const checkpointPath = getCheckpointPath();
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as RuntimeCheckpoint;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCheckpoint(checkpoint: RuntimeCheckpoint) {
  const checkpointDir = getCheckpointDir();
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(getCheckpointPath(), JSON.stringify(checkpoint, null, 2), 'utf8');
}

export function clearCheckpoint() {
  const checkpointPath = getCheckpointPath();
  if (!fs.existsSync(checkpointPath)) {
    return;
  }

  try {
    fs.unlinkSync(checkpointPath);
  } catch {
    // best effort cleanup
  }
}
