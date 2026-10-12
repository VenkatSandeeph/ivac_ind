/**
 * beep.ts -- Dual beep alert for calendar visibility
 *
 * Plays a short Windows beep alert (two blips: 1000Hz then 1500Hz).
 * Fire-and-forget: spawns a detached PowerShell process with stdio ignored
 * and unref()'d, so it runs entirely off the main thread and cannot block
 * or slow the booking flow.
 *
 * Extracted from src/index.ts so it can be shared between the OFC stage
 * (src/index.ts) and the consular stage (src/consular-schedule.ts) without
 * circular imports.
 *
 * Windows only; no-op on other platforms.
 */
import { spawn as spawnCmd } from 'child_process';

/**
 * Plays a dual beep alert. Fire-and-forget — does not block the caller.
 *
 * The PowerShell script uses [console]::beep(frequencyHz, durationMs):
 *   - First blip:  1000Hz for 300ms
 *   - Gap:         120ms
 *   - Second blip: 1500Hz for 300ms
 */
export function playBeep(): void {
  if (process.platform !== 'win32') return;
  try {
    const psScript = '[console]::beep(1000,300); Start-Sleep -Milliseconds 120; [console]::beep(1500,300)';
    const child = spawnCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch {
    // non-fatal — sound is best-effort
  }
}
