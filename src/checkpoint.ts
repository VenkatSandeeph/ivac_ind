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

const checkpointDir = path.resolve(process.cwd(), 'artifacts', 'state');
const checkpointPath = path.join(checkpointDir, 'checkpoint.json');

export function loadCheckpoint(): RuntimeCheckpoint | null {
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
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
}

export function clearCheckpoint() {
  if (!fs.existsSync(checkpointPath)) {
    return;
  }

  try {
    fs.unlinkSync(checkpointPath);
  } catch {
    // best effort cleanup
  }
}
