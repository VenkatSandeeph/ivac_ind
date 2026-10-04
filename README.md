# US Visa Scheduling Automation (IVAC)

Robust, continuously-running automation for booking OFC appointments on [usvisascheduling.com](https://www.usvisascheduling.com). Built on [Patchright](https://github.com/nicepkg/patchright) (a stealth fork of Playwright) and a real Chrome browser connected via CDP.

> **Two clients:** this document covers the **desktop** launcher (Electron + core). The **Android** app — a standalone Kotlin port running the same booking loop on-device — lives in `mobile_session/` and is documented in [`docs/mobile.md`](docs/mobile.md). Full docs set: [`docs/architecture.md`](docs/architecture.md) (system + diagrams) · [`docs/desktop.md`](docs/desktop.md) · [`docs/mobile.md`](docs/mobile.md) · [`docs/operations.md`](docs/operations.md) (build/debug) · [`docs/known-issues.md`](docs/known-issues.md).

---

## Table of Contents

1. [Setup](#setup)
2. [Running](#running)
3. [Configuration](#configuration)
4. [How It Works](#how-it-works)
5. [City Rotation](#city-rotation)
6. [Special Window Timing](#special-window-timing)
7. [Direct API Flow (3-Tier)](#direct-api-flow-3-tier)
8. [Cloudflare Auto-Solve](#cloudflare-auto-solve)
9. [Browser Resilience](#browser-resilience)
10. [Checkpoint & Crash Recovery](#checkpoint--crash-recovery)
11. [Recovery Strategy](#recovery-strategy)
12. [Desktop UI Launcher](#desktop-ui-launcher)
13. [Building a Single Windows Executable](#building-a-single-windows-executable)
14. [Diagnostics](#diagnostics)
15. [Project Structure](#project-structure)
16. [Notes](#notes)

---

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install Patchright browser:

   ```bash
   npm run prepare
   ```

3. Copy the example config:

   ```bash
   copy config.example.json config.local.json
   ```

4. Edit `config.local.json` with your values (see [Configuration](#configuration) below).

5. (Optional) Set up license key:
   - Place your license key in a `.license` file next to the executable
   - Format: JSON `{"key": "IVAC-XXXX-XXXX-XXXX-XXXX"}` or plain text
   - License validation is performed at startup

## Running

### CLI (headless mode)

```bash
npm start
```

This runs `tsx src/index.ts` directly. The script connects to Chrome via CDP, runs the full automation loop, and never exits until an appointment is booked (or you stop it).

### Desktop UI

```bash
npm run ui:start
```

Opens an Electron desktop window with controls for starting/stopping the script, connecting Chrome, viewing logs, and updating retry timing. See [Desktop UI Launcher](#desktop-ui-launcher) for details.

## Recommended Chrome Launch

The script launches Chrome automatically using the configured executable and user data directory. If you want to reuse an existing Chrome session, start Chrome manually with:

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\chrome-debug"
```

---

## Configuration

All settings live in `config.local.json` (or equivalent environment variables). The file is loaded once at startup and the config object is passed to all functions -- hot-path functions never re-read from disk.

### Required Fields

| Field | Env Var | Description |
|---|---|---|
| `authUrl` | `AUTH_URL` | Full B2C / usvisascheduling login URL |
| `username` | `USERNAME` | Login username |
| `password` | `PASSWORD` | Login password |
| `appointment.city` | `APPOINTMENT_CITY` | Target city name (string or array of cities for rotation) |
| `appointment.month` | `APPOINTMENT_MONTH` | Target month (`"Sep"` or `9`) |
| `appointment.year` | `APPOINTMENT_YEAR` | Target year (`2026`) |
| `appointment.startDate` | `APPOINTMENT_START_DATE` | Earliest acceptable date (`"2026-08-10"`) |
| `appointment.endDate` | `APPOINTMENT_END_DATE` | Latest acceptable date (`"2026-12-31"`) |
| `securityQuestions` | `SECURITY_QUESTIONS` | Array of `{ question, answer }` pairs |

### Optional Fields

| Field | Env Var | Default | Description |
|---|---|---|---|
| `scheduleUrl` | `SCHEDULE_URL` | `.../en-US/ofc-schedule/` | OFC schedule page URL |
| `appointment.preferredTime` | `APPOINTMENT_PREFERRED_TIME` | `null` | Preferred time slot text to match |
| `chromeExecutable` | `CHROME_EXECUTABLE` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome binary path |
| `chromeUserDataDir` | `CHROME_USER_DATA_DIR` | `C:\temp\chrome-debug` | Chrome user data directory |
| `chromeRemoteDebugPort` | `CHROME_REMOTE_DEBUG_PORT` | `9222` | Chrome CDP port |
| `cityRetrySeconds` | `CITY_RETRY_SECONDS` | `10` | Base delay (seconds) between city retry attempts |
| `maxSlotAttempts` | `MAX_SLOT_ATTEMPTS` | `10` | Max slot selection attempts |
| `slotRetryDelayMs` | `SLOT_RETRY_DELAY_MS` | `10000` | Delay between slot retries (ms) |
| `cloudflareWaitMs` | `CLOUDFLARE_WAIT_MS` | `180000` | Manual Cloudflare solve timeout (ms) |
| `maxDateAttempts` | `MAX_DATE_ATTEMPTS` | `3` | Date/time selection retries per city |
| `uiApiMismatchRetries` | `UI_API_MISMATCH_RETRIES` | `2` | Retries when API says no slots but UI might differ |
| `uiApiMismatchRetryDelayMs` | `UI_API_MISMATCH_RETRY_DELAY_MS` | `1000` | Delay between mismatch retries (ms) |
| `dryRun` | `DRY_RUN` | `true` | When `true`, skips the final submit click (safe testing mode) |
| `autoSolveCloudflare` | `AUTO_SOLVE_CLOUDFLARE` | `false` | Auto-solve Cloudflare Turnstile with human-like Bezier curve clicks |
| `debugNetwork` | `DEBUG_NETWORK` | `false` | Log all XHR/fetch requests |
| `headless` | `HEADLESS` | `false` | Run Chrome in headless mode |
| `alertOnMajorEvents` | `ALERT_ON_MAJOR_EVENTS` | `true` | Send login/submit events to Supabase |
| `screenshotAfterSelection` | `SCREENSHOT_AFTER_SELECTION` | `true` | Screenshot after date/time selection |

> **Important:** `dryRun` defaults to `true`. Set it to `false` in your config to enable actual appointment submission.

### License Management

The application uses a license validation system tied to a Supabase database. License keys are validated at startup and must be active, not terminated, and not expired.

**License Key Format:** `IVAC-XXXX-XXXX-XXXX-XXXX` (uppercase alphanumeric, no O/0/I/1)

**License Storage:**
- Place your license key in a `.license` file next to the executable
- Supported formats:
  - JSON: `{"key": "IVAC-XXXX-XXXX-XXXX-XXXX"}`
  - Plain text: `IVAC-XXXX-XXXX-XXXX-XXXX`

**License States:**
- `valid`: License is active and not expired
- `invalid_key`: Key not found in database
- `deactivated`: License exists but is not active
- `terminated`: License has been terminated by administrator
- `expired`: License has passed its expiry date
- `network_error`: Cannot reach license server (check network/proxy)

**Generating License Keys (for administrators):**

```bash
# Set the service role key
set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Generate a license key
node scripts/gen-license.mjs "Client Name" --expires 2027-01-01
```

**Checking RLS Policies:**

```bash
# Verify that anon role can read/update the Licenses table
set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
node scripts/fix-rls.mjs
```

### Config Validation

The config loader (`config.ts`) performs strict validation at startup:

- `authUrl` must be a real usvisascheduling or B2C login URL (not a placeholder)
- `username` and `password` must not be empty or placeholder values
- `appointment.city` must be non-empty (string or non-empty array)
- `appointment.startDate` must be earlier than or equal to `appointment.endDate`
- `appointment.month` must be a valid month number (1-12) or short name (Jan-Dec)
- `appointment.year` must be a valid four-digit year (>=2000)

If validation fails, the script throws a descriptive error and exits immediately.

---

## How It Works

1. **Connect to Chrome** -- Connects to Chrome via CDP (`connectOverCDP`). Launches Chrome automatically if no existing CDP endpoint is reachable. Probes for existing relevant-site tabs before opening new ones.
2. **Resume from current page** -- Inspects the current URL and DOM to determine state (login, security questions, Cloudflare, home, schedule, etc.) and takes the appropriate action. Runs up to 30 detection attempts.
3. **Sign in** -- Fills username/password fields with human-like delays. Retries up to 3 times if intermediate "Sign in" pages appear. Detects credential errors and aborts.
4. **Answer security questions** -- Matches visible question text against configured Q&A pairs using fuzzy substring matching. Locates answer fields via DOM traversal.
5. **Handle Cloudflare challenges** -- Detects Turnstile/CAPTCHA via multiple selectors and page title. Auto-solves with Bezier curve mouse movement or waits for manual completion.
6. **Navigate to OFC Schedule** -- Goes to the home page, clicks "Schedule Appointment" (`#continue_application`), waits for the city dropdown to appear.
7. **Select city** -- Selects from the `#post_select` dropdown. Dispatches `change`, `input`, `mousedown`, `mouseup`, and `click` events. Optionally selects an empty value first to force a schedule refresh.
8. **Wait for schedule API** -- Intercepts the POST to `get-family-ofc-schedule-days`. Parses the response for `ScheduleDays` and `ScheduleEntries`.
9. **Direct API flow (3-tier)** -- After a successful city selection (HTTP 200), attempts to book the appointment via direct API calls before falling back to DOM:
   - **Tier 1: jQuery `$.ajax()`** -- Uses the page's own jQuery to call `getScheduleEntries` and `submit` directly. Inherits all page headers and Cloudflare tokens. ~600ms total.
   - **Tier 2: Raw XMLHttpRequest** -- Falls back to raw XHR if jQuery is unavailable. ~600ms total.
   - **Tier 3: Fast DOM + response capture** -- Clicks the date cell in the calendar (triggering the page's own `getScheduleEntries`), captures the response, and submits via DOM click. Zero extra API requests. ~2-3s total.
   - **Fallback: Standard DOM flow** -- If all tiers fail or Cloudflare blocks, falls back to the standard DOM flow below (~7-10s).
10. **Select month/year** -- Sets the `.ui-datepicker-month` and `.ui-datepicker-year` select elements to the configured values.
11. **Choose date** -- Reads available dates from the calendar UI (`td[data-month][data-year]`), filters by the configured date range, and clicks the earliest (or preferred) date. Falls back to cross-month scanning if the configured month has no availability.
12. **Select time slot** -- Reads time rows from `#time_select tbody tr`. Prefers the configured `preferredTime` if available. Otherwise selects the slot with the highest `data-slots` availability.
13. **Submit appointment** -- Waits for the submit button (`#submitbtn`) to become enabled. Respects `dryRun` mode. Logs the selected time and sends a Supabase event before clicking.
14. **Run continuously** -- The main loop never exits. Recovers from errors, Cloudflare challenges, session expiry, HTTP 403/429, and page crashes automatically.

---

## City Rotation

When multiple cities are configured (e.g. `"city": ["City A", "City B", "City C"]`), the script rotates through them deterministically:

- Uses a simple `cityIndex` variable that increments: `cityIndex = (cityIndex + 1) % appointmentCities.length`
- Rotation happens when:
  - The schedule API reports no availability for the current city
  - The schedule API times out
  - A date/time selection loop exhausts its retries
- For a single city, the index stays at 0 (rotation is a no-op)
- When multiple cities are configured, `uiApiMismatchRetries` is forced to 0 to prefer rotating to the next city immediately rather than repeatedly reselecting the same city

If a checkpoint exists from a previous run, the city index is restored to match the checkpoint's city.

---

## Special Window Timing

The script targets "special window" minutes each hour when appointment slots are more likely to appear. This is handled by the `computeRetryDelay()` function:

**Special window minutes:** `:26`, `:56`, `:57`, `:58`

**How it works:**
1. If the current minute is already a special window minute, the retry delay is shortened to **3 seconds** for rapid reselection during the window.
2. If the next special window arrives before the normal retry delay would elapse, the delay is shortened to land exactly at the start of the window.
3. Otherwise, the normal delay is used: `cityRetrySeconds * 1000 + random(0-2000ms)` jitter.

The `getCityRefreshDelayMs()` function (used in date/time retry loops) has its own fast-retry windows at minutes `:25:40`-`:26:59` and `:55:40`-`:56:59`, where the delay is `random(0-10000ms)`.

---

## Direct API Flow (3-Tier)

After a successful city selection (HTTP 200 from `getScheduleDays`), the script attempts to book the appointment using direct API calls before falling back to the slower DOM flow. This is critical for the special window timing where slots disappear within 5-10 seconds.

### Tier 1: jQuery `$.ajax()` (~600ms)

Uses the page's own `window.jQuery.ajax()` to call the backend APIs directly. This inherits all page-configured headers, anti-forgery tokens, and Cloudflare cookies -- making it identical to how the page makes its own calls. Most reliable approach.

### Tier 2: Raw XMLHttpRequest (~600ms)

Falls back to raw `XMLHttpRequest` when jQuery is unavailable. Manually sets `Content-Type`, `X-Requested-With`, and `Accept` headers. May be detected by Cloudflare as a non-standard request pattern.

### Tier 3: Fast DOM + Response Capture (~2-3s)

When API calls are blocked by Cloudflare:
1. Clicks the date cell in the calendar (triggers the page's own `getScheduleEntries` request)
2. Captures the response via a `page.on('response')` listener
3. Selects the radio button and clicks submit via DOM

This makes **zero extra API requests** -- all requests go through the page's own jQuery code with proper Cloudflare tokens. Much faster than the standard DOM flow (~7-10s) because it skips rendering waits.

### Fallback: Standard DOM Flow (~7-10s)

If all 3 tiers fail, the script falls back to the original DOM-based flow: wait for calendar rendering, click dates, wait for time table rendering, select radio, wait for submit button, click submit.

### Response Capture

The script captures the page's own API responses to avoid making duplicate requests (which trigger Cloudflare 403):
- `query-family-members` -- Application IDs (extracted from DOM checkboxes instead)
- `get-family-ofc-schedule-days` -- Schedule days + token (reused from page's own call)
- `get-family-ofc-schedule-entries` -- Time slots + token (captured for Tier 3)

### Session-Level Blocking

If Cloudflare blocks direct API calls (403/429 or HTML challenge page), the script sets a session-level `directApiBlocked` flag and uses the standard DOM flow for the remainder of the session. Context extraction failures and no-slots outcomes do NOT set this flag -- only actual Cloudflare blocks.

---

## Cloudflare Auto-Solve

When `autoSolveCloudflare` is `true`:

1. **Auto-resolve wait (15s)** -- Patchright + real Chrome often passes Turnstile without interaction. The script waits up to 15 seconds checking each second.
2. **Turnstile checkbox detection** -- If still present, locates the checkbox via 4 strategies:
   - `#cf-turnstile` / `.cf-turnstile` container bounding box
   - `challenges.cloudflare.com` iframe checkbox
   - Hidden widget anchor (`input[id^="cf-chl-widget-"]`) parent element
   - Fallback `label:has-text("Verify you are human")` and similar selectors
3. **Bezier curve click** -- Generates a cubic Bezier curve from a random starting point to the checkbox. Moves the mouse along 25-45 points with 3-10ms delays between each, then clicks. The curve has randomized control points for natural-looking movement.
4. **Retry** -- Up to 3 click attempts with 15-second verification waits after each.
5. **Fallback** -- If auto-solve is exhausted, falls back to manual wait (up to `cloudflareWaitMs`).

**Challenge detection** checks:
- Page title containing "Just a moment" or "Waiting room"
- 12 different CSS/text selectors for iframes, checkboxes, and challenge text
- Body text regex matching verification/CAPTCHA keywords

---

## Browser Resilience

The script detects browser disconnections and crashes using `isBrowserClosedError()`, which matches error messages like `target closed`, `browser has been closed`, `context has been closed`, `session closed`, and `connection refused`.

When a browser-closed error is detected:
- The `reconnectBrowser()` function logs the event and exits the process (`process.exit(0)`)
- The UI detects the exit code and shows a "Browser was closed" banner with pulsing "Connect Chrome" and "Start" buttons
- The user clicks "Connect Chrome" to relaunch Chrome, then "Start" to restart the automation

Browser-closed errors are caught at three levels:
1. **Initial resume** -- During startup `resumeFromCurrentPage()`
2. **Health check** -- At the top of each main loop iteration
3. **Catch-all** -- In the outer `try/catch` that wraps each iteration

---

## Checkpoint & Crash Recovery

The checkpoint system saves automation state to `artifacts/state/checkpoint.json` after key milestones:

| Checkpoint State | When Saved |
|---|---|
| `city_selection` | Before selecting a city |
| `date_selected` | After a date is chosen |
| `time_selected` | After a time slot is chosen |
| `checkpoint_resume` | After fast-resuming from a valid checkpoint |
| `booked` | After successful appointment submission |
| `error_recovery` | After an uncaught error in the main loop |

**Fast-resume logic:** On startup, if a checkpoint exists with state `city_selection`, `date_selected`, or `time_selected`, and the browser is already on the schedule page with the correct city selected, the script skips city reselection and proceeds directly to date/time selection.

**Stop signal:** The UI uses a file-based stop mechanism (`.ivac-stop`). The main loop checks for this file at the top of each iteration. When found, the file is deleted and `process.exit(0)` is called, leaving Chrome running. The UI also has a 5-second fallback `taskkill` in case the graceful stop doesn't work.

---

## Recovery Strategy

### Layer 1: Health Check (top of every iteration)

Before each city selection, verifies the page is still on the schedule page (`/en-US/ofc-schedule` + `#post_select` present). If not, calls `resumeFromCurrentPage()` which handles:

| Detected State | Action |
|---|---|
| Internal page (`about:blank`, `chrome://`) | Navigate to `authUrl` |
| Schedule page | Return immediately |
| Cloudflare/Turnstile | Auto-solve or wait for manual completion |
| Login failed page | Navigate to `authUrl` and restart |
| Login page | Fill credentials and submit |
| Security questions page | Answer and submit |
| Home page | Click "Schedule Appointment" |
| Irrelevant site | Navigate to `authUrl` |
| Relevant but unrecognized | Wait 2s and retry detection |

### Layer 2: Specific Error Handlers (inside try block)

- **HTTP 403:** Navigate home via `a[title="Visa Application Home"]` link (or `getHomePageUrl()`), call `resumeFromCurrentPage()`, wait with exponential backoff (10s / 90s / 15min tiers based on consecutive count).
- **HTTP 429:** Exponential backoff: `min(10min, 30s * consecutiveCount)` + random jitter up to 5s.
- **No availability:** Check calendar UI for dates despite API saying none (UI-API mismatch). Retry reselection `uiApiMismatchRetries` times (0 if multi-city). If still no slots, rotate to next city with `computeRetryDelay()`.
- **Schedule timeout:** Wait 5s for calendar to appear. If visible, proceed to date/time flow. If not, rotate to next city.
- **Calendar not rendering:** 3 recovery attempts per date attempt -- reselect city, then hard-navigate to schedule URL + `resumeFromCurrentPage()`. If all fail, break to outer loop and retry with next city.
- **No time slots:** Retry date/time selection within the same city up to `maxDateAttempts` times.
- **Submit failed:** Retry date/time selection without reselecting city.

### Layer 3: Catch-all (outer try/catch)

Any uncaught exception is caught, a checkpoint is saved with state `error_recovery`, and `resumeFromCurrentPage()` is called before continuing the loop. If the error is a browser-closed error, `reconnectBrowser()` is called instead. The script never exits due to an error.

---

## Desktop UI Launcher

```bash
npm run ui:start
```

The UI is an Electron application with a hybrid architecture:

### Architecture

- **`ui/main.js`** -- Electron main process that runs a built-in HTTP API server on `http://127.0.0.1:3456`. The Electron `BrowserWindow` loads this URL. The HTTP server serves static files and exposes REST API endpoints for script control.
- **`ui/renderer.js`** -- Browser-side JavaScript that communicates with the API server via `fetch()`. No `nodeIntegration` or `contextIsolation` bridge is needed.
- **`ui/index.html` + `ui/styles.css`** -- Layout and styling with a clean, minimal design.

### Features

- **Status badge** -- Shows "Running" (green) or "Stopped" (red) in the top bar
- **Config display** -- Username, appointment details (city, month/year, date range), Chrome debug status
- **Start / Stop** -- Start spawns the automation script (`tsx src/index.ts` in dev, `ivac-core.exe` in production). Stop writes a `.ivac-stop` signal file for graceful exit with a 5-second `taskkill` fallback.
- **Connect Chrome** -- Probes the configured CDP port. If Chrome is not running, launches it with `--remote-debugging-port` and `--no-first-run`.
- **Reload Config** -- Re-reads `config.local.json` and updates the display
- **Update Retry Time** -- Writes a new `cityRetrySeconds` value to `config.local.json`
- **Live log stream** -- Polls `/api/logs` every 2 seconds and auto-scrolls
- **Clear Logs** -- Clears the in-memory log buffer
- **Browser-closed banner** -- Orange warning banner with pulsing buttons when the browser is detected as closed

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Returns `{ running, chromeConnected, chromePort, browserClosed, stoppedByBrowser }` |
| `/api/config` | GET | Returns username, appointment details, configPath, cityRetrySeconds |
| `/api/start` | POST | Spawns the automation script as a child process |
| `/api/stop` | POST | Writes stop signal file + fallback taskkill |
| `/api/connect-chrome` | POST | Probes CDP port, launches Chrome if needed |
| `/api/logs` | GET | Returns the full log buffer |
| `/api/logs` | DELETE | Clears the log buffer |
| `/api/retry-time` | POST | Saves `{ value }` as `cityRetrySeconds` to config |

### Single-instance Lock

The Electron app uses `app.requestSingleInstanceLock()` to prevent multiple instances. If a second instance is launched, it focuses the existing window.

---

## Building a Single Windows Executable

```bash
npm run build:release
```

This produces `release/win-unpacked/` (ready to run) and `release/IVAC-Launcher.zip` (distributable). Edit the config, then run:

```powershell
.\release\win-unpacked\IVAC Launcher.exe
```

### Build Pipeline

The release build (`scripts/build-release.mjs`) performs the following steps:

1. **TypeScript Compilation** (`npx tsc -p tsconfig.json`)
   - Compiles TypeScript to JavaScript
   - Outputs to `dist/` directory
   - Target: ES2020, CommonJS modules

2. **Core Script Protection** (`node scripts/protect.mjs`)
   - Bundles with esbuild
   - Minifies code (syntax, whitespace, variable name mangling)
   - Adds inspector shim for pkg compatibility
   - Outputs to `protected/app.js`

3. **Native Executable Compilation** (`@yao-pkg/pkg`)
   - Packages `protected/app.js` into `dist/ivac-core.exe`
   - Target: node24-win-x64
   - Uses `--no-bytecode --public` flags to preserve `Function.prototype.toString()`
   - Includes patchright browser metadata as assets

4. **UI Obfuscation** (temporary, in-place)
   - Obfuscates `ui/main.js` and `ui/renderer.js`
   - Uses javascript-obfuscator with Playwright-safe settings
   - Creates backups of original files

5. **Electron Packaging** (`electron-builder`)
   - Packages Electron app to `release/win-unpacked/`
   - Includes UI files, `ivac-core.exe`, and patchright node_modules
   - Target: Windows directory (not installer)
   - Signing: disabled

6. **Restore UI Files**
   - Restores original `ui/main.js` and `ui/renderer.js` from backups
   - Ensures source remains readable for development

7. **Create Distributable Zip**
   - Compresses `release/win-unpacked/` to `release/IVAC-Launcher.zip`
   - Removes runtime artifacts (chrome-debug directory)

### Individual Build Steps

**Development Build:**
```bash
npm run build
```
Compiles TypeScript to JavaScript for development.

**Protection Build:**
```bash
npm run protect
```
Bundles and minifies the core script for production.

**Core Executable:**
```bash
npm run build:core
```
Creates the standalone `ivac-core.exe` automation script.

**Clean Build Artifacts:**
```bash
npm run clean
```
Removes `dist/` and `protected/` directories.

### Protection Strategy

The code protection uses a multi-layered approach:

1. **esbuild Minification:**
   - Shortens variable names
   - Compacts code
   - Playwright-safe (preserves function expression boundaries)

2. **pkg Native Compilation:**
   - Embeds source code in V8 snapshot inside the .exe
   - Not accessible as readable JS
   - Uses `--no-bytecode` to preserve `Function.prototype.toString()` for Playwright

3. **Inspector Shim:**
   - Provides stub for `node:inspector` that pkg strips
   - Required by patchright-core at module init time

4. **UI Obfuscation:**
   - javascript-obfuscator with Playwright-safe settings
   - String array disabled to avoid breaking Playwright
   - Only applied to UI files (not core automation)

Note: The exe does not bundle browser binaries. Ensure Chrome is installed on the target machine or connect to an existing remote-debugging Chrome via `chromeRemoteDebugPort`.

---

## Utility Scripts

The `scripts/` directory contains utility scripts for building, licensing, and maintenance:

| Script | Purpose |
|--------|---------|
| `build-release.mjs` | Full release build pipeline (TS → protect → pkg → Electron → zip) |
| `protect.mjs` | Code protection (esbuild bundling + minification) |
| `gen-license.mjs` | Generate license keys for clients (requires SUPABASE_SERVICE_ROLE_KEY) |
| `fix-rls.mjs` | Check and fix Supabase RLS policies for the Licenses table |
| `gen-license.mjs` | Generate license keys with optional expiry dates |

**Example: Generate a license key**
```bash
set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
node scripts/gen-license.mjs "John Doe" --expires 2027-01-01
```

## Diagnostics

Artifacts are saved to `artifacts/`:

| Directory | Contents |
|---|---|
| `screenshots/` | PNG screenshots captured on errors and after date/time selection |
| `logs/` | Page state dumps (URL, title, body text) |
| `traces/` | Playwright traces (zip files) |
| `state/checkpoint.json` | Runtime checkpoint for crash recovery |

Screenshot naming convention: `{event}-{timestamp}.png` (e.g. `date-selected-2026-09-15-1724601234567.png`)

---

## Project Structure

```
src/
  index.ts               Main orchestrator loop, state machine, recovery, direct API integration
  api-direct.ts          3-tier direct API: jQuery $.ajax, raw XHR, fast DOM + response capture
  config.ts              Config loading, validation, type definitions
  browser.ts             Chrome launch, CDP connection, port probing
  auth.ts                Login form detection, credential entry, retry logic
  security-questions.ts  Security question matching and answering
  cloudflare.ts          Turnstile/CAPTCHA detection, Bezier curve auto-solve
  ofc-schedule.ts        City selection, time slots, appointment submission (OFC)
  consular-schedule.ts   Consular stage scheduling (after OFC success)
  calendar.ts            Calendar month/year navigation, date selection
  schedule-api.ts        Schedule API response interceptor and parser
  network-monitor.ts     XHR/fetch request/response logging
  checkpoint.ts          Checkpoint save/load/clear for crash recovery
  diagnostics.ts         Screenshots, page state dumps, traces
  supabase.ts            Optional telemetry event logging
  logger.ts              Structured console logging (INFO/WARN/ERROR/DEBUG)
  utils.ts               Shared helpers (pageHasSelector, isLoginPage, waitForPortOpen)
  license.ts             License validation against Supabase
  login-dedup.ts         Login deduplication for multi-tab scenarios
  types/
    third-party.d.ts     Type declarations for third-party modules

ui/
  main.js                Electron main process + HTTP API server
  renderer.js            Browser-side UI logic (fetch-based API calls)
  index.html             UI layout (two-column: config panel + log panel)
  styles.css             UI styles (CSS custom properties, responsive grid)

scripts/
  build-release.mjs      Full release build pipeline (tsc -> protect -> pkg -> electron -> zip)
  protect.mjs            esbuild bundling + minification + inspector shim
  gen-license.mjs        License key generation + Supabase insertion
  fix-rls.mjs            Supabase RLS policy verification

mobile_session/
  app/                   Android project — standalone Kotlin port (see docs/mobile.md)
    app/src/main/java/com/ivac/mobile/   Engine, WebView driver, WireGuard VPN, Store, Telegram
  tools/                 Vendored toolchain (JDK 17, Gradle 8.9, Android SDK)
  profiles_import.json   Seed config imported by the app on launch

scripts/
  build-release.mjs      Full release build pipeline (tsc -> protect -> pkg -> electron -> zip)
  protect.mjs            esbuild bundling + minification + inspector shim
  gen-license.mjs        License key generation + Supabase insertion
  fix-rls.mjs            Supabase RLS policy verification
  test-supabase-logging.mjs  Supabase telemetry smoke test

docs/                    Full documentation set (architecture, desktop, mobile, operations, known-issues)
.devin/skills/           Agent workflow skills (ivac-repo, ivac-desktop, ivac-mobile)

config.example.json      Example config template
config.local.json        User config (gitignored)
ARCHITECTURE.md          Technical architecture documentation (desktop)
AGENTS.md                Product improvement notes and repository guidance
```

---

## Notes

- Do not store secrets in source control. `config.local.json` is ignored by `.gitignore`.
- Supabase telemetry is optional and fire-and-forget; failures are silently ignored.
- The browser automation uses Patchright for stealth (avoids bot detection fingerprints).
- The script supports `pkg`-bundled executables by resolving `patchright` from `node_modules` at runtime via `eval('require')`.
- Human-like delays (750ms + random jitter) are added before filling form fields to avoid bot detection.
- The city dropdown dispatches multiple DOM events (`change`, `input`, `mousedown`, `mouseup`, `click`) to ensure the site's JavaScript handlers fire correctly.
- When multiple cities are configured, the script skips UI-API mismatch retries and rotates to the next city immediately for better coverage.
