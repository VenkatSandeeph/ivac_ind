/**
 * date-experiment.ts -- EXPERIMENTAL JSONL recorder for avoidEarliestDate A/B
 *
 * Records two event types so dev-build runs can answer "did 2nd-date-first
 * ordering actually help?":
 *
 *   decision — emitted by orderDatesForAttempt on every candidate ordering:
 *              which dates were in range, the working-day gap, whether the
 *              rule fired (reordered) or WOULD have fired (enabled=false
 *              still records wouldReorder — baseline data while the toggle
 *              is off).
 *
 *   outcome  — emitted per attempted date: which position in the attempt
 *              order it was (pos), whether it was the promoted 2nd date
 *              (promoted), and how the attempt ended (booked / slot_gone /
 *              throttled / no_entries / no_eligible / error / hard_error).
 *
 * Join decision↔outcome on runId+attempt (DOM) or postId+timestamp (fast
 * flow) — same fields as slot-observations.jsonl for a consistent view.
 *
 * KEY DESIGN: fire-and-forget, mirrors slot-tracker.ts. Returns void, the
 * fs write is .catch()-ed — recording must NEVER break or slow the loop.
 *
 * Output: logs/date-experiment.jsonl (one JSON object per line, append-only)
 *
 * To remove: delete this file, the ctx/meta argument at the three
 * orderDatesForAttempt call sites, and the recordDateExperiment emits.
 */
import fs from 'fs';
import path from 'path';
import { info } from './logger';

// Resolve the log directory relative to the project root — same pkg-aware
// rule as slot-tracker.ts so dev (tsx) and packaged cores log identically.
function getLogFile(): string {
  const root = typeof (process as any).pkg !== 'undefined'
    ? path.dirname(process.execPath)
    : process.cwd();
  return path.join(root, 'logs', 'date-experiment.jsonl');
}

export type DateExperimentEvent = {
  type: 'decision' | 'outcome';
  /** Which code path produced the event */
  path?: 'fast' | 'dom' | 'rescue' | 'consular';
  profile?: string;
  city?: string;
  runId?: string;
  attempt?: number;
  postId?: string;
  [key: string]: unknown;
};

// Writes are serialized through this chain — concurrent events must keep
// call order (a decision must land before its outcomes) and appendFile
// ordering is not guaranteed when fired in parallel.
let writeQueue: Promise<void> = Promise.resolve();

export function recordDateExperiment(event: DateExperimentEvent): void {
  const record = { timestamp: new Date().toISOString(), ...event };
  const logFile = getLogFile();
  writeQueue = writeQueue
    .then(() => fs.promises.mkdir(path.dirname(logFile), { recursive: true }))
    .then(() => fs.promises.appendFile(logFile, JSON.stringify(record) + '\n', 'utf8'))
    .catch((err: unknown) => {
      info('[date-experiment] Failed to write record:', err instanceof Error ? err.message : String(err));
    });
}
