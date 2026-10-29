import util from 'util';

// Build mode: 'client' (release) or 'dev' (development).
// Injected by esbuild define in protect.mjs. Defaults to 'dev' when running
// directly via tsx (npm start) or when the env var is not set.
const isClientMode = process.env.IVAC_BUILD_MODE === 'client';

const levelLabels = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG'
} as const;

// Patterns that must never appear in client-build output. They reveal internal
// services (license backend, notification channel) and may carry secrets — the
// whole line is dropped in client mode regardless of log level.
const CLIENT_HIDDEN_PATTERNS = [
  'supabase',
  'telegram',
  'chat_id',
  'ptgvkfawdwgwlrpuowjk' // license backend project ref
];
// Telegram bot-token shape: "123456789:AAxx..." — catches tokens embedded in
// URLs or error bodies without hardcoding the token itself.
const BOT_TOKEN_RE = /\b\d{8,10}:[A-Za-z0-9_-]{30,}/;

function isClientHidden(text: string): boolean {
  const lower = text.toLowerCase();
  return CLIENT_HIDDEN_PATTERNS.some((p) => lower.includes(p)) || BOT_TOKEN_RE.test(text);
}

// Machine markers the UI parses out of the core's stdout (ui/main.js):
// [UI_STATUS] → profile status label, [BROWSER_CLOSED] → banner,
// [STOPPED]/[RESUMED] → paused flag. In client mode these MUST keep
// printing even though all other info/warn lines are suppressed —
// dropping them breaks the UI.
const UI_MARKER_RE = /\[(UI_STATUS|BROWSER_CLOSED|STOPPED|RESUMED)\]/;
function isUiMarker(text: string): boolean {
  return UI_MARKER_RE.test(text);
}

// HH:mm:ss local time — prepended to every client-build line so release logs
// carry real timing detail (when a 403 hit, slot cadence, etc.).
function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function clientPrefix(label: string): string {
  return `[${ts()}] [${label}]`;
}

function format(...args: Array<unknown>) {
  return args
    .map((value) =>
      typeof value === 'string'
        ? value
        : util.inspect(value, {
            depth: 3,
            colors: false,
            breakLength: 120
          })
    )
    .join(' ');
}

/**
 * Info log — developer detail.
 * Dev mode: [INFO] msg.
 * Client mode: suppressed — the client log is verdicts only (client() +
 * error()). The one exception is UI markers ([UI_STATUS]/[BROWSER_CLOSED]/
 * [STOPPED]) which the Electron UI parses out of the stream.
 */
export function info(...args: Array<unknown>) {
  const line = format(...args);
  if (isClientMode) {
    if (isClientHidden(line)) return;
    if (!isUiMarker(line)) return;
    console.log(clientPrefix(levelLabels.info), line);
    return;
  }
  console.log(`[${levelLabels.info}]`, line);
}

/**
 * Warn log — developer detail.
 * Dev mode: [WARN] msg.
 * Client mode: suppressed like info() (UI markers still pass). Callers that
 * need the user to see a warning must emit a client() verdict line — that is
 * the existing convention ("client() = user-facing, warn() = diagnostics").
 */
export function warn(...args: Array<unknown>) {
  const line = format(...args);
  if (isClientMode) {
    if (isClientHidden(line)) return;
    if (!isUiMarker(line)) return;
    console.warn(clientPrefix(levelLabels.warn), line);
    return;
  }
  console.warn(`[${levelLabels.warn}]`, line);
}

/**
 * Error log. Always shown (even in client mode) because errors are important.
 * In client mode, prefixed with timestamp + ❌ emoji for visual clarity.
 * Supabase/Telegram-related errors are still suppressed in client mode.
 */
export function error(...args: Array<unknown>) {
  const line = format(...args);
  if (isClientMode) {
    if (isClientHidden(line)) return;
    console.log(`${clientPrefix(levelLabels.error)} ❌`, line);
    return;
  }
  console.error(`[${levelLabels.error}]`, line);
}

/**
 * Debug log. Only shown when DEBUG_NETWORK env var is set.
 * Not affected by client/dev mode — but hidden-service lines are still
 * suppressed in client mode (network dumps can contain tokens).
 */
export function debug(...args: Array<unknown>) {
  if (process.env.DEBUG_NETWORK !== 'true') return;
  const line = format(...args);
  if (isClientMode) {
    if (isClientHidden(line)) return;
    console.debug(clientPrefix(levelLabels.debug), line);
    return;
  }
  console.debug(`[${levelLabels.debug}]`, line);
}

/**
 * Client-facing log. Always shown in both client and dev modes.
 * Formatted with an emoji prefix for visual clarity in the UI log box.
 * In client mode a HH:mm:ss timestamp is inserted after the emoji.
 *
 * Use this for high-level status updates that the end user should see:
 *   - City selection ("Checking HYDERABAD VAC...")
 *   - Slot found ("Slot found! Date: X, Time: Y")
 *   - Submit results ("OFC BOOKED!")
 *   - Recovery ("Cloudflare blocked — recovering...")
 *   - Errors that the user needs to know about
 *
 * @param emoji - Emoji string to prefix the message (e.g. '🔍', '✅', '❌')
 * @param args - Message content (same formatting as info/warn/error)
 */
export function client(emoji: string, ...args: Array<unknown>) {
  const line = format(...args);
  if (isClientMode) {
    if (isClientHidden(line)) return;
    console.log(`${emoji} [${ts()}] ${line}`);
    return;
  }
  console.log(`${emoji} ${line}`);
}

/**
 * Backend error report — uniform, greppable format for EVERY error the
 * backend returns (HTTP blocks and app-level HasError codes alike).
 *
 *   [WARN] [BACKEND_ERROR] route | http=403 | code=SGA14 | detail
 *
 * Dev mode gets the full detail line; client mode suppresses it (warn() is
 * dev-only there) — so callers MUST also emit a client() verdict line with
 * a user-friendly explanation + the action being taken.
 */
export function backendError(
  source: string,
  status: number | null,
  code: string | null,
  detail?: string
) {
  const parts = [
    `${source} | http=${status === null ? 'n/a' : status}`,
    `code=${code || 'n/a'}`,
    detail || null
  ].filter(Boolean);
  warn(`[BACKEND_ERROR] ${parts.join(' | ')}`);
}

/**
 * Machine-readable UI status marker. ui/main.js parses `[UI_STATUS] <label>`
 * out of the log stream and uses it as the profile's current-state label —
 * explicit and stable, unlike the keyword matching it falls back to.
 */
export function uiStatus(label: string) {
  info(`[UI_STATUS] ${label}`);
}
