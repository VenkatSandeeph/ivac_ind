# Architecture -- IVAC Visa Scheduling Automation

> **Scope:** desktop core + launcher. For the combined system view (desktop + Android, Mermaid diagrams) see [`docs/architecture.md`](docs/architecture.md); for the Android app internals see [`docs/mobile.md`](docs/mobile.md).

## Overview

- **Purpose:** Robust Patchright-based automation to book OFC appointments on usvisascheduling.com.
- **Goal:** Be resilient to Cloudflare challenges, login expirations, HTTP 403/429, page crashes, browser disconnections, and transient errors. The script runs continuously until an appointment is booked and never exits on failure.

---

## Browser Runtime

- Uses [Patchright](https://github.com/nicepkg/patchright), a stealth fork of Playwright that avoids common bot detection fingerprints.
- Connects to Chrome via CDP (`connectOverCDP`) on the configured remote debugging port.
- Falls back to launching Chrome with `spawn` if no existing CDP endpoint is reachable.
- When connecting to an existing browser, prioritizes tabs already on `usvisascheduling.com` or `b2clogin.com`, then blank tabs, then opens a new tab.
- Supports `pkg`-bundled executables by resolving `patchright` from `node_modules` at runtime via `eval('require')`.

---

## Core Components

| Module | Responsibility |
|---|---|
| `index.ts` | Main orchestrator -- infinite loop, state machine (`resumeFromCurrentPage`), health checks, error recovery, city rotation, special window timing, checkpoint management, direct API integration |
| `api-direct.ts` | Fast Flow module — books OFC appointments by leveraging the page's own JavaScript functions (onClickSubmit, onPostChange, jsdata). Captures page's own API responses. Falls back to DOM flow on failure. |
| `config.ts` | Config loading from `config.local.json` and env vars, strict validation, type definitions (`AutomationConfig`, `AppointmentConfig`, `SecurityQuestionConfig`) |
| `browser.ts` | Chrome launch (`launchBrowser`), CDP connection (`connectToBrowser`), port probing (`ensureChromeRunning`), tab selection logic |
| `auth.ts` | Login form detection, credential entry with human-like delays, submit with retry (up to 3 attempts), credential error detection |
| `security-questions.ts` | Security question matching (fuzzy substring), answer field location via DOM traversal, form submission |
| `cloudflare.ts` | Turnstile/CAPTCHA detection (12 selectors + body text regex), 4-strategy auto-solve with Bezier curve mouse movement, fallback to manual wait |
| `ofc-schedule.ts` | City dropdown selection with DOM event dispatch, time slot selection (preferred or highest-availability), appointment submission |
| `consular-schedule.ts` | Consular appointment scheduling -- city selection, date/time selection, and submission for the consular stage (navigated to after OFC success) |
| `calendar.ts` | Calendar readiness check, month/year `<select>` manipulation, available date extraction from `td[data-month][data-year]`, date clicking with in-page event dispatch fallback |
| `schedule-api.ts` | Network response interceptor for `get-family-ofc-schedule-days` POST requests, JSON extraction with malformed-JSON fallback |
| `login-dedup.ts` | Login deduplication -- prevents duplicate login attempts when multiple tabs or resume paths trigger login simultaneously |
| `network-monitor.ts` | XHR/fetch logging -- always logs important status codes (403, 429, 5xx), debug-level logging when `debugNetwork` is enabled |
| `checkpoint.ts` | Crash recovery -- saves/loads state to `artifacts/state/checkpoint.json` |
| `diagnostics.ts` | Screenshots (`artifacts/screenshots/`), page state dumps (`artifacts/logs/`), Playwright traces (`artifacts/traces/`) |
| `supabase.ts` | Optional telemetry event logging to Supabase (fire-and-forget) |
| `logger.ts` | Structured console logging with `[INFO]`, `[WARN]`, `[ERROR]`, `[DEBUG]` prefixes. Uses `util.inspect` for object formatting |
| `utils.ts` | Shared helpers: `pageHasSelector`, `isLoginPage`, `waitForPortOpen`, `normalizeText` |

---

## License System

### License Validation (`license.ts`)

The application uses a Supabase-based license validation system to control access and track usage.

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `validateLicense(licenseKey)` | Validates license key against Supabase, checks active/terminated/expired status |
| `readStoredLicenseKey()` | Reads license key from `.license` file next to executable |
| `storeLicenseKey(key)` | Stores license key to `.license` file in JSON format |
| `clearStoredLicenseKey()` | Removes stored license key from disk |
| `getSystemName()` | Returns system identifier: `HOSTNAME\Username` |
| `getLicenseFilePath()` | Resolves path to `.license` file (handles pkg bundling) |

**License Record Structure:**
```typescript
type LicenseRecord = {
  id: string;
  license_key: string;
  client_name: string;
  active: boolean;
  terminated: boolean;
  system_name: string | null;
  expires_at: string | null;
  last_validated_at: string | null;
  created_at: string;
};
```

**Validation Result:**
```typescript
type LicenseResult = {
  valid: boolean;
  status: 'valid' | 'invalid_key' | 'deactivated' | 'terminated' | 'expired' | 'network_error';
  message: string;
  record?: LicenseRecord;
};
```

**Validation Logic:**
1. Check if license key exists in database
2. Verify `terminated` flag is false
3. Verify `active` flag is true
4. Check `expires_at` date (if present) against current time
5. On success, update `system_name` and `last_validated_at` in database
6. Handle network errors (TLS, proxy, connectivity)

**Supabase Configuration:**
- URL: `https://ptgvkfawdwgwlrpuowjk.supabase.co`
- Table: `Licenses`
- Key: Publishable key (anon access with RLS policies)

**License Key Format:**
- Format: `IVAC-XXXX-XXXX-XXXX-XXXX`
- Characters: Uppercase alphanumeric (no O/0/I/1 to avoid confusion)
- Example: `IVAC-ABCD-1234-EFGH-5678`

### License Generation Scripts

**`scripts/gen-license.mjs`**
- Generates new license keys and inserts them into Supabase
- Usage: `node scripts/gen-license.mjs <client_name> [--expires YYYY-MM-DD]`
- Requires `SUPABASE_SERVICE_ROLE_KEY` environment variable
- Output: License key, client name, and database ID

**`scripts/fix-rls.mjs`**
- Checks and fixes Supabase RLS policies for the Licenses table
- Tests anon key access vs service_role key access
- Provides SQL commands to fix missing RLS policies
- Requires `SUPABASE_SERVICE_ROLE_KEY` environment variable

---

## Build and Release Scripts

### Script Overview

| Script | Purpose | Key Features |
|--------|---------|--------------|
| `build-release.mjs` | Full release build pipeline | TypeScript → protect → pkg → Electron → zip |
| `protect.mjs` | Code protection | esbuild bundling + minification + inspector shim |
| `gen-license.mjs` | License key generation | Crypto-based key generation + Supabase insertion |
| `fix-rls.mjs` | RLS policy verification | Tests anon access, provides fix SQL |

### Build Pipeline (`build-release.mjs`)

**Step 1: TypeScript Compilation**
```bash
npx tsc -p tsconfig.json
```
- Compiles TypeScript to JavaScript
- Outputs to `dist/` directory
- Target: ES2020, CommonJS modules

**Step 2: Core Script Protection**
```bash
node scripts/protect.mjs
```
- Bundles with esbuild
- Minifies code (syntax, whitespace, variable name mangling)
- Adds inspector shim for pkg compatibility
- Outputs to `protected/app.js`

**Step 3: Native Executable Compilation**
```bash
npx @yao-pkg/pkg -t node24-win-x64 --no-bytecode --public -o dist/ivac-core.exe protected/app.js
```
- Packages `protected/app.js` into native executable
- Target: node24-win-x64
- Flags:
  - `--no-bytecode`: Embeds source as plain JS (not V8 bytecode)
  - `--public`: Public snapshot (preserves `Function.prototype.toString()`)
- Includes patchright browser metadata as assets

**Step 4: UI Obfuscation (Disabled)**
- UI obfuscation is **disabled** for reliability reasons
- javascript-obfuscator breaks Playwright's function serialization and UI event handlers
- The build script backs up and restores `ui/main.js` and `ui/renderer.js` as a safety measure
- Original UI files remain readable for development

**Step 5: Electron Packaging**
```bash
npx electron-builder --win --dir --config
```
- Packages Electron app to `release<N>/win-unpacked/`
- Configuration from temporary `scripts/build-release-temp.json`:
  - App ID: `com.ivac.launcher`
  - Product name: `IVAC Launcher`
  - ASAR: true
  - Files: UI files only
  - Extra files: `ivac-core.exe`, `node_modules/patchright`, `node_modules/patchright-core`
  - Signing: disabled (`sign: false`)
- Environment variables for signing bypass:
  - `CSC_IDENTITY_AUTO_DISCOVERY: false`
  - `WIN_CSC_LINK: ""`
- **Known issue:** `winCodeSign` extraction fails with symlink privilege error on non-elevated Windows. The build script continues because the unpacked app and ZIP are still created. Code signing is NOT performed. This should not be reported as successful signing.

**Step 6: Restore UI Files**
- Restores original `ui/main.js` and `ui/renderer.js` from backups
- Ensures source remains readable for development

**Step 7: Create Distributable Zip**
```bash
powershell -NoProfile -Command "Compress-Archive -Path 'release<N>/win-unpacked\*' -DestinationPath 'release<N>/IVAC-Launcher.zip' -Force"
```
- Compresses `release<N>/win-unpacked/` to `release<N>/IVAC-Launcher.zip`
- Output: Ready-to-distribute archive (~149 MB)

### Protection Strategy (`protect.mjs`)

**esbuild Configuration:**
```javascript
{
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  keepNames: false,
  external: ["playwright", "playwright-core", "electron"]
}
```

**Inspector Shim:**
- Provides stub for `node:inspector` that pkg strips from binaries
- Required by patchright-core at module init time
- Implements no-op Session, open, close, url, and console methods

**Why This Approach:**
- esbuild minification is Playwright-safe (preserves function expression boundaries)
- Primary protection comes from pkg's native binary compilation (V8 snapshot)
- Code is embedded as plain JS (not bytecode) to preserve `Function.prototype.toString()`
- javascript-obfuscator was removed because it breaks Playwright's function serialization
- UI obfuscation is disabled because it breaks Electron UI event handlers

**External Dependencies:**
- `playwright` - Supplied by node_modules at runtime
- `playwright-core` - Supplied by node_modules at runtime
- `electron` - Supplied by node_modules at runtime

---

## Key Functions

### State Detection (`index.ts`)

| Function | Returns `true` when... |
|---|---|
| `isSchedulePage(page)` | URL contains `/en-US/ofc-schedule` AND `#post_select` is present |
| `isLoginPage(page)` | `#signInName` or username/email input fields are present |
| `isSecurityQuestionPage(page)` | `p.textInParagraph[id^="kbq"]` AND `input[type="password"]` present |
| `isHomePage(page)` | URL contains `/en-US/` (not ofc-schedule) AND `#continue_application` present |
| `isVerificationPage(page)` | Delegates to `isHumanVerificationPresent()` |
| `isInternalPage(page)` | URL is blank, `chrome://`, `edge://`, `devtools://`, or empty |
| `isRelevantSite(page)` | URL matches `usvisascheduling.com` or `b2clogin.com` |

### Core Orchestration (`index.ts`)

- **`resumeFromCurrentPage(page, config, options?)`** -- Central state machine. Inspects current URL and DOM to determine state, then takes recovery action. Up to 30 detection attempts. Supports `allowNavigation: false` for checkpoint resume to avoid unnecessary navigation.

- **`computeRetryDelay(baseSeconds, totalCities)`** -- Unified retry delay computation with special window awareness. Returns `{ delayMs, isSpecialWindow, specialMinute }`. Behavior:
  - **Inside a special window** (`:00, :01, :21, :26, :56, :57, :58`): Uses a fixed 2s delay for fast cycling through all desired cities. After one full round through all cities, returns to normal delay. Tracks round completion via `specialWindowCitiesChecked` counter.
  - **Outside a special window**: If the next special window arrives within the normal delay, shortens the delay to hit the window exactly (so the first city selection lands at `:26:00`). Otherwise returns `baseSeconds * 1000 + random(0-2000ms)`.

- **`msUntilNextSpecialWindow()`** -- Calculates milliseconds until the next special window minute. Checks all target minutes `[0, 1, 21, 26, 56, 57, 58]` and returns the closest one.

- **`isBrowserClosedError(err)`** -- Pattern-matches error messages for `target closed`, `browser has been closed`, `context has been closed`, `session closed`, `connection refused`.

- **`reconnectBrowser(config)`** -- Logs the browser-closed event and calls `process.exit(0)`. The UI detects this exit and shows the browser-closed banner.

- **`getBackoffDelayMs(kind, consecutiveCount)`** -- Exponential backoff with jitter. For 403: 10s (1-2), 90s (3-5), 15min (6+). For 429: `min(10min, 30s * count)`.

### License Functions (`license.ts`)

- **`validateLicense(licenseKey)`** -- Validates license key against Supabase. Checks for key existence, terminated flag, active status, and expiry date. Updates `system_name` and `last_validated_at` on success. Returns `LicenseResult` with status and message.

- **`readStoredLicenseKey()`** -- Reads license key from `.license` file next to executable. Supports both JSON format (`{"key": "..."}`) and plain text. Returns `null` if file doesn't exist or is invalid.

- **`storeLicenseKey(key)`** -- Stores license key to `.license` file in JSON format. Overwrites existing file.

- **`clearStoredLicenseKey()`** -- Removes the `.license` file from disk. Silently ignores errors.

- **`getSystemName()`** -- Returns system identifier in format `HOSTNAME\Username` using `os.hostname()` and `os.userInfo().username`.

- **`getLicenseFilePath()`** -- Resolves path to `.license` file. Handles pkg bundling by using `process.execPath` when bundled, otherwise `process.cwd()`.

### Schedule Page (`ofc-schedule.ts`)

- **`selectCity(page, city, skipEmpty, config)`** -- Selects a city from the OFC dropdown. First selects the empty option (if `skipEmpty` is false) to force a schedule refresh, then selects the target city. Dispatches `change`, `input`, `mousedown`, `mouseup`, `click` events. Adds 0-500ms random jitter before selection. After selection, waits up to 15s for the calendar to appear and sends a Supabase event with detected available dates.

- **`getAvailableTimeCandidates(page, preferredTime)`** / **`selectTimeCandidate(page, candidate)`** -- Reads time rows from `#time_select tbody tr` (`data-slots` attr or cell text for availability), sorts preferred-first, then checks the chosen row's radio via `page.evaluate()`.

- **`submitAppointment(page, config)`** -- Waits for `#submitbtn` to become enabled (up to 15s). Falls back to role-based button lookup. Sends Supabase event before clicking. Returns `true` on success, `false` on failure.

- **`parseManualResponse(response)`** -- Extracted helper that parses schedule API JSON responses (with fallback for malformed JSON). Used to detect manual city selections by the user in the browser.

### Calendar (`calendar.ts`)

- **`waitForCalendarReady(page, timeoutMs)`** -- Polls for `#datepicker` or `.ui-datepicker` container with either `.ui-datepicker-group` or day cells visible.

- **`selectCalendarMonthYear(page, month, year)`** -- Sets `.ui-datepicker-month` and `.ui-datepicker-year` `<select>` elements. Supports both numeric months and short names. Iterates all visible month/year selectors (handles multi-month calendars).

- **`getAvailableDates(page)`** -- Reads available (non-disabled) day cells. Extracts date from `data-month` and `data-year` attributes on `<td>`, or falls back to reading month/year labels from the datepicker group. Returns `DateCell[]` with `{ date: "YYYY-MM-DD", locator }`.

- **`getDatesWithAllAvailable(page, startDate, endDate, preferredDates)`** -- Single DOM read returning both all green dates and the in-range subset (preferred-first, then chronological).

- **`clickCalendarDate(page, dateStr)`** -- In-page date clicking. Iterates `.ui-datepicker-group` elements, matches month/year, finds the day link, and dispatches `mousedown`/`mouseup`/`click` events.

### Schedule API (`schedule-api.ts`)

- **`waitForScheduleResponse(page, timeoutMs)`** -- Monitors network for POST requests to `/custom-actions/.../get-family-ofc-schedule-days`. Returns `ScheduleApiResult` with status, availability, parsed schedule days/entries, and timeout flag. Uses `extractJsonObject()` to handle malformed JSON responses.

### Fast Flow Module (`api-direct.ts`)

The Fast Flow module books OFC appointments by leveraging the page's own
JavaScript framework. It does NOT make direct API calls (XHR/fetch) — instead
it uses real Playwright clicks on the page's DOM elements (radio parent
label/td, submit button) which trigger the page's own jQuery `$.ajax()`
calls. This handles Cloudflare cookies, headers, and page-internal Tokens
automatically.

#### Why It Exists

The standard DOM flow takes ~7-10 seconds per date attempt because it waits for:
1. Calendar rendering after city selection (~2s)
2. Date cell click + `getScheduleEntries` response + time table rendering (~3s)
3. Radio button selection + submit button enable wait (~2s)
4. Submit click + navigation (~3s)

In the special window minutes (`:00, :01, :21, :26, :56, :57, :58`), slots
disappear within ~7-10 seconds. The DOM flow is too slow. The Fast Flow
reduces this to ~2-3 seconds per date attempt.

#### How It Works — 3-Phase Flow

```
runDirectOfcFlow(page, config)
  |
  +-- Phase 1: City Selection (done by caller)
  |     Caller sets #post_select + calls onPostChange()
  |     Page makes getScheduleDays API call
  |     setupApiResponseCapture captures days + Token1
  |
  +-- Phase 2: Date Click
  |     For each matching date (sorted earliest first):
  |       Find date cell in calendar, tag with data-fastflow-target
  |       Playwright page.click() the cell (real click, triggers PCF framework)
  |       Page makes getScheduleEntries API call
  |       setupApiResponseCapture captures entries + Token2
  |
  +-- Phase 3: Submit (ONE slot per date)
        Try the best (highest-availability) slot for this date:
          Tag radio's parent label/td with data-fastflow-radio-parent
          Playwright page.click() the parent (triggers PCF onSelectScheduleEntry)
          Wait 500ms for submit button to enable (50ms polling)
          Force-enable if needed (fallback)
          Playwright page.click() #submitbtn
          Wait for response (60s first date, 30s subsequent dates):
            AllScheduled=true → SUCCESS → navigate to consular
            HasError=true → move to NEXT DATE (not next slot)
            HTTP 524 → server timeout, wait 5s, move to next date
            HTTP 429 → rate limited, wait 5s, move to next date
            Navigation to /en-US/schedule/ → SUCCESS
        On failure: move to next date (fresh Token from new getScheduleEntries)
        If all dates exhausted: return all_exhausted → caller re-selects city
```

#### Submit Strategy: One Slot Per Date

After a failed submit, the Token from `getScheduleEntries` is consumed.
Re-clicking the SAME date does NOT trigger a new `getScheduleEntries` call
(the date is already selected). But clicking a DIFFERENT date does.

So instead of burning through all slots on one date with a stale Token,
the Fast Flow tries only the best slot on each date, moving to the next
date on failure. This ensures every submit uses a fresh Token.

```
Example with 3 dates in range:
  Date 1 (Oct 27): click → 4 slots → try best (13:00, avail=6) → FAIL
    → move to Date 2 (fresh Token from new getScheduleEntries)
  Date 2 (Oct 28): click → 2 slots → try best (10:00, avail=4) → FAIL
    → move to Date 3 (fresh Token)
  Date 3 (Nov 15): click → 3 slots → try best (09:30, avail=8) → SUCCESS

If only 1 date is available:
  Date 1 (Oct 27): click → 4 slots → try best → FAIL
    → all_exhausted → caller re-selects city (full refresh)
```

#### Radio Click: Parent Label/TD

The PCF framework attaches its click handler to the parent `<label>` or
`<td>` wrapper, NOT the raw `<input type="radio">` element. Clicking the
raw input directly is fast (~36ms) but doesn't trigger the framework's
`onSelectScheduleEntry()`. The Fast Flow tags the parent wrapper with
`data-fastflow-radio-parent` and clicks that instead, which triggers the
framework and sets `jsdata.Num` synchronously.

#### Submit Button: Smart Wait + Force-Enable

After the radio click, the PCF framework's `toggleSubmit()` should enable
the submit button. The Fast Flow polls the button's disabled state every
50ms for up to 500ms. If the framework enables it, it clicks immediately.
If not, it force-enables the button and clicks (the framework may have
set `jsdata.Num` even if `toggleSubmit()` didn't run).

#### Date Capture: String and Object Support

The API may return `ScheduleDays` as:
- Plain strings: `["2026-10-27", "2026-10-28"]`
- Objects with `Date`: `[{ Date: "2026-10-27", ID: "..." }]`
- Objects with `ScheduleDate`: `[{ ScheduleDate: "2026-10-27", ID: "..." }]`
- Objects with other fields: `CalendarDate`, `Day`, `SlotDate`

The `extractDateField()` and `extractIdField()` helpers normalize all
these formats into a consistent `ScheduleDay` representation.

#### Error Handling

| Error | Behavior |
|---|---|
| `PSE0602`, `PSE0612`, `PSE0610` | Hard error — stop all attempts for this city |
| HTTP 524 (Cloudflare timeout) | Server overloaded — wait 5s, move to next date |
| HTTP 429 (Rate limited) | Wait 5s, move to next date |
| "time no longer available" | Token consumed — move to next date (fresh Token) |
| Navigation timeout | Move to next date |
| `all_exhausted` | All dates tried — caller re-selects city for fresh state |

#### Response Capture System

`setupApiResponseCapture(page)` registers listeners that capture the page's
own API responses without making duplicate requests:

| Captured Response | Used For |
|---|---|
| `query-family-members` | Application IDs |
| `get-family-ofc-schedule-days` | Schedule days + Token1 |
| `get-family-ofc-schedule-entries` | Time slots + Token2 |
| `schedule-ofc-appointments-for-family` | Submit result (AllScheduled/HasError) |

`resetCapturedScheduleData()` is called before each city selection to prevent
reusing stale data from a previous city.

#### Fallback

If the Fast Flow returns `all_exhausted` or `hard_error`, the DOM flow is
SKIPPED (it would repeat the same failures with the same stale state).
The outer loop re-selects the city and starts fresh.

If the Fast Flow returns `no_slots`, `no_dates_in_range`, or `blocked`,
the DOM flow takes over as a fallback.

#### Consular Stage Diagnostics

`setupConsularResponseCapture(page)` in `consular-schedule.ts` installs
similar response listeners for the consular stage, logging:
- `getScheduleDays` response (day count, token presence)
- `getScheduleEntries` response (entry count, token presence)
- Submit response (AllScheduled, HasError, RedirectStub, Errors)
- Per-submit timing

This gives full visibility into the consular booking process for debugging.

#### Consular Stage: Continuous Monitoring with 403 Recovery

After OFC is booked, the script transitions to `/en-US/schedule/` (consular
page). The consular stage uses `runConsularStageWithRecovery()` in `index.ts`,
which wraps `runConsularSchedule()` with:

1. **Continuous monitoring**: If no slots are found, waits 12-15s and retries.
   Does not return false on "no slots" — keeps trying until consular is booked
   or the stop signal is detected.

2. **403 recovery**: When Cloudflare blocks consular API requests (HTTP 403 +
   PSE0501 dialog), the script:
   - Clicks "Visa Application Home" link (or navigates to home URL)
   - Waits for Cloudflare verification to clear (`resumeFromCurrentPage`)
   - Clicks "Schedule Appointment" on the home page
   - Since OFC is already booked, the site navigates directly to
     `/en-US/schedule/` (consular), not `/en-US/ofc-schedule/`
   - Retries the consular city selection

3. **Backoff**: After 3 consecutive 403 recovery cycles, waits 60s before
   retrying to avoid hammering the server.

4. **Stop signal checking**: Between consular monitoring attempts, the script
   checks for the stop signal file, allowing the user to stop the script
   during the consular stage.

#### Notification Video Behavior

The notification video (YouTube alert) opens **immediately** when OFC is
booked, before the consular stage begins. This ensures the user is alerted
even if:
- The consular stage takes a long time to find slots
- The consular stage gets stuck on 403 errors
- The script is restarted from a checkpoint after OFC was booked

The video opens only once per run (tracked by `notificationVideoOpened` flag).
It does not open again after consular success or failure.

#### Cloudflare HTML Challenge Detection

Cloudflare can return HTTP 200 with an HTML challenge page instead of JSON. All three XHR catch blocks check for:
- `Just a moment` (Cloudflare challenge page title)
- `__cf_chl` (Cloudflare challenge token)
- `<html` or `<!DOCTYPE` (HTML response instead of JSON)

If detected, the response is treated as `blocked: true`, setting `directApiBlocked` and falling back to DOM flow.

#### Diagnostic Logs [TEMP LOG]

Temporary diagnostic logs marked with `[TEMP LOG]` for easy removal:
- **jQuery availability**: Whether `window.jQuery` / `window.$` exists, and `$.ajaxSettings` configuration
- **Cookie names**: All cookies on the domain (verifies `cf_clearance`, `__cf_bm` presence)
- **Session request counter**: Every API call through `/custom-actions/` counted and logged
- **Session stats**: Total API calls and elapsed time at flow start

#### Key Functions

- **`setupApiResponseCapture(page)`** -- Registers response listener for capturing page's own API data
- **`resetCapturedScheduleData()`** -- Clears captured data before city selection
- **`extractPageContext(page)`** -- Extracts primaryId, appd, postId, applications from DOM (no API calls)
- **`makePageApiCall(page, route, appd, jsdata)`** -- Universal API call helper (Tier 1 jQuery, Tier 2 XHR)
- **`directGetScheduleDays(page, ctx)`** -- Fallback for when response capture misses
- **`directGetScheduleEntries(page, ctx, day, token)`** -- Gets time slots for a date via API
- **`directSubmitAppointment(page, ctx, day, entry, token)`** -- Submits appointment via API
- **`fastDomGetEntries(page, day)`** -- Tier 3: clicks date, captures page's response
- **`fastDomSubmit(page, entry, config)`** -- Tier 3: selects radio + clicks submit via DOM
- **`runDirectOfcFlow(page, config)`** -- Main entry point, orchestrates all 3 tiers
- **`filterScheduleDays(days, config)`** -- Filters dates to configured range, sorts chronologically
- **`sortScheduleEntries(entries, preferredTime)`** -- Sorts time slots by preferred time

#### Integration in `index.ts`

The direct flow is attempted after a successful page-driven city selection (`scheduleResult.status === 200`):

```typescript
if (!directApiBlocked && scheduleResult && scheduleResult.status === 200) {
  const directResult = await runDirectOfcFlow(page, config);
  if (directResult.fallback && directResult.reason === 'blocked') {
    directApiBlocked = true; // session-level block
  }
  if (directResult.success) {
    // OFC booked! Navigate to consular stage
  }
  // If not successful, continue with standard DOM flow
}
```

#### OFC API Endpoints

| Endpoint | Purpose |
|---|---|
| `/api/v1/schedule-group/query-family-members-ofc` | Get family members + application IDs |
| `/api/v1/schedule-group/get-family-ofc-schedule-days` | Get available dates |
| `/api/v1/schedule-group/get-family-ofc-schedule-entries` | Get time slots for a date |
| `/api/v1/schedule-group/schedule-ofc-appointments-for-family` | Submit appointment |

All requests go through `/en-US/custom-actions/?route=<encoded-route>&appd=<value>&cacheString=<timestamp>` with POST body `parameters=<json>`.

#### Page Context Extraction

| Field | Source | Example |
|---|---|---|
| `primaryId` | Inline script regex: `jsdata['primaryId'] = '...'` | `9784178e-...` |
| `appd` | Inline script regex: `appd=...` | `70c81aa1-...` |
| `postId` | `#post_select` dropdown value | `436bf614-...` |
| `applications` | `#gm_select li input[type="checkbox"]` values | `["12345", "67890"]` |

### Auth (`auth.ts`)

- **`login(page, config)`** -- Fills username and password with 750ms+ human-like delays. Locates fields via cascading fallback strategies (ID selectors, aria labels, title/placeholder attributes, frame search). Submits and checks for credential errors. Up to 3 retry attempts for intermediate sign-in pages.

### Cloudflare (`cloudflare.ts`)

- **`waitForHumanVerificationIfNeeded(page, timeoutMs, autoSolve)`** -- Main entry point. Phase 1: 15s auto-resolve wait. Phase 2: 3 Bezier curve click attempts. Phase 3: manual wait fallback.

- **`findAndClickTurnstile(page)`** -- 4-strategy Turnstile finder. Returns `true` if a click was performed.

- **`isHumanVerificationPresent(page)`** -- Checks page title and 12 DOM selectors for challenge indicators.

- **`isLoginFailedPage(page)`** -- Detects `ExternalAuthenticationFailed` in URL or error alerts with login failure text.

---

## Special Window Timing

### Observed Slot Opening Times

On `usvisascheduling.com`, new appointment slots typically open at specific
minute marks of each hour:
- **Primary windows**: `:26` and `:56` (most common)
- **Secondary windows**: `:00`, `:01`, `:21` (occasionally)

Slots open at **:00 seconds** of these minutes (e.g., `:26:00`, `:56:00`).
All cities' slots open simultaneously, but the script can only check one city
at a time. Slots with low availability (avail=1) disappear within ~7-10 seconds.

### Special Window Minutes

```typescript
const SPECIAL_WINDOW_MINUTES = [0, 1, 21, 26, 56, 57, 58];
```

### Behavior

The `computeRetryDelay(baseSeconds, totalCities)` function controls the delay
between city selections:

1. **Outside a special window**: Normal delay (`baseSeconds * 1000 + 0-2000ms` jitter).
   If the next special window arrives within the normal delay, the delay is
   shortened to hit the window exactly (so the first city selection lands at
   `:26:00`).

2. **Inside a special window**: Fixed 2s delay for fast cycling through all
   desired cities. A counter (`specialWindowCitiesChecked`) tracks how many
   cities have been checked during this window.

3. **After one full round**: Once all desired cities have been checked once,
   the script returns to normal delay. This prevents endless fast-cycling
   and rate limiting.

### Example Timeline (3 cities)

```
12:25:50 → Normal delay would land at 12:26:02
           Special window at :26 is 10s away → shorten to 10s
12:26:00 → Select MUMBAI VAC → 0 slots (round 1/3)
12:26:02 → Select DELHI VAC → 0 slots (round 2/3)
12:26:04 → Select HYDERABAD VAC → 1 date → BOOK
           OR if no slots:
12:26:04 → Select HYDERABAD VAC → 0 slots (round 3/3)
           All cities checked → return to normal delay
12:26:14 → Normal monitoring continues
```

### Rate Limiting Considerations

The in-window delay is 2s (fixed, no jitter). This results in ~0.5 API calls
per second — well below the rate that triggers HTTP 429 responses. The previous
3s delay was more conservative but slower. The 2s delay checks 3 cities in 6
seconds, which is within the 7-10s slot lifetime for avail=1 slots.

## Main Loop Structure

```
main()
  +-- clearStopSignal()
  +-- loadConfig()
  +-- readStoredLicenseKey() and validateLicense() if license key present
  +-- ensureChromeRunning(config)
  +-- connectToBrowser(config) or launchBrowser(config)
  +-- monitorNetwork(page)
  +-- resumeFromCurrentPage(page, config)    <-- initial state detection
  +-- Initialize: appointmentCities[], cityIndex, consecutive403/429
  +-- Load checkpoint (if exists): restore attempt, cityIndex, fast-resume flag
  |
  +-- while (!booked)
        +-- Check stop signal (.ivac-stop file)
        |     +-- if found -> process.exit(0) (Chrome stays open)
        |
        +-- Health check: verify page is alive and on schedule page
        |     +-- if not on schedule -> resumeFromCurrentPage()
        |     +-- if browser closed -> reconnectBrowser() -> exit
        |     +-- if recovery fails -> wait 5s, continue
        |
        +-- try { // main loop iteration
        |     +-- Checkpoint fast-resume logic
        |     |     +-- If checkpoint active and city matches -> skip reselection
        |     |     +-- If checkpoint but city mismatch -> reselect city
        |     |
        |     +-- Normal city selection path:
        |     |     +-- Save checkpoint (state: city_selection)
        |     |     +-- resetCapturedScheduleData() -- clear stale API captures
        |     |     +-- Start schedule response listener
        |     |     +-- Start manual selection listener (25s timeout)
        |     |     +-- selectCity(page, currentCity)
        |     |     +-- await schedule response
        |     |     +-- Check for manual city selection (different response)
        |     |
        |     +-- Direct API flow (if not blocked and scheduleResult.status === 200):
        |     |     +-- runDirectOfcFlow(page, config)
        |     |     |     +-- Tier 1: jQuery $.ajax() for getScheduleEntries + submit
        |     |     |     +-- Tier 2: Raw XHR fallback
        |     |     |     +-- Tier 3: Fast DOM (click date, capture response, DOM submit)
        |     |     |     +-- Returns: success | no_slots | no_dates_in_range | all_exhausted | blocked
        |     |     +-- If success: navigate to consular stage, break
        |     |     +-- If blocked: set directApiBlocked = true (session-level)
        |     |     +-- If not success: continue to standard DOM flow below
        |     |
        |     +-- HTTP 403 recovery
        |     |     +-- Navigate home -> resumeFromCurrentPage()
        |     |     +-- Exponential backoff (10s/90s/15min tiers)
        |     |     +-- continue
        |     |
        |     +-- HTTP 429 recovery
        |     |     +-- Exponential backoff (min(10min, 30s*count))
        |     |     +-- continue
        |     |
        |     +-- No availability handling
        |     |     +-- Check calendar UI for dates (UI-API mismatch)
        |     |     +-- If manual selection detected with calendar -> proceed
        |     |     +-- Retry reselection uiApiMismatchRetries times
        |     |     +-- If multi-city: skip retries, rotate immediately
        |     |     +-- computeRetryDelay() for next city timing
        |     |     +-- Log special window info if applicable
        |     |     +-- cityIndex = (cityIndex + 1) % length
        |     |     +-- continue
        |     |
        |     +-- Schedule timeout handling
        |     |     +-- Wait 5s for calendar to appear
        |     |     +-- If calendar visible -> proceed to date/time
        |     |     +-- If not -> rotate to next city with computeRetryDelay()
        |     |
        |     +-- Date/time selection loop (maxDateAttempts):
        |     |     +-- waitForCalendarReady (with 3 recovery attempts)
        |     |     +-- selectCalendarMonthYear
        |     |     +-- getDatesWithAllAvailable + clickDateCell
        |     |     |     +-- If no date in month -> cross-month scan
        |     |     |     +-- If no date at all -> break to outer loop
        |     |     +-- Save checkpoint (state: date_selected)
        |     |     +-- Screenshot (if enabled)
        |     |     +-- getAvailableTimeCandidates + selectTimeCandidate
        |     |     |     +-- If no time -> retry date/time loop
        |     |     +-- Save checkpoint (state: time_selected)
        |     |     +-- Screenshot (if enabled)
        |     |     +-- submitAppointment
        |     |     +-- If booked -> save checkpoint (state: booked), break
        |     |     +-- If submit failed -> retry date/time loop
        |     |
        |     +-- if dateLoopContinue -> continue outer loop (next city)
        |
        +-- } catch (loopErr)                <-- catch-all
              +-- if browser closed -> reconnectBrowser() -> exit
              +-- Save checkpoint (state: error_recovery)
              +-- resumeFromCurrentPage()
              +-- if recovery also fails -> wait 10s
              +-- continue
```

---

## Checkpoint States

```
city_selection ---> date_selected ---> time_selected ---> booked
       |                  |                  |
       v                  v                  v
  error_recovery    error_recovery    error_recovery
       |
       v
  checkpoint_resume (fast-resume after restart)
```

### Checkpoint Fields

```typescript
type RuntimeCheckpoint = {
  runId: string;        // unique per run: "run-{timestamp}-{random}"
  state: string;        // one of the states above
  attempt: number;      // current attempt number
  city?: string;        // city being processed
  url?: string;         // current page URL
  date?: string;        // selected date (YYYY-MM-DD)
  time?: string;        // selected time slot text
  lastError?: string;   // error message (for error_recovery)
  timestamp: string;    // ISO timestamp
};
```

---

## Config Type (`AutomationConfig`)

All fields are properly typed -- no `as any` casts:

```typescript
type AutomationConfig = {
  authUrl: string;
  scheduleUrl: string;
  username: string;
  password: string;
  securityQuestions: SecurityQuestionConfig[];
  appointment: AppointmentConfig;
  chromeExecutable: string;
  chromeUserDataDir: string;
  chromeRemoteDebugPort: number;
  maxSlotAttempts: number;
  slotRetryDelayMs: number;
  cityRetrySeconds: number;
  cloudflareWaitMs: number;
  debugNetwork: boolean;
  autoSolveCloudflare: boolean;
  headless: boolean;
  alertOnMajorEvents: boolean;
  screenshotAfterSelection: boolean;
  uiApiMismatchRetries: number;
  uiApiMismatchRetryDelayMs: number;
  maxDateAttempts: number;
};

type AppointmentConfig = {
  city: string | string[];        // single city or array for rotation
  month: string | number;         // "Sep" or 9
  year: number;
  startDate: string;              // "YYYY-MM-DD"
  endDate: string;                // "YYYY-MM-DD"
  preferredTime?: string | null;  // e.g. "09:00 AM"
};

type SecurityQuestionConfig = {
  question: string;               // substring to match against page text
  answer: string;
};
```

Config is loaded once at startup and passed as a parameter to all functions. Hot-path functions (`selectCity`, `submitAppointment`) never re-read `config.local.json` from disk.

### Validation Rules

1. `authUrl` must be a non-empty URL containing `usvisascheduling.com`, `b2clogin.com`, `/oauth2/`, or `/authorize`
2. `username` and `password` must not be empty or contain placeholder text (`YOUR_USERNAME`, etc.)
3. `appointment.city` must be non-empty
4. `startDate` <= `endDate`
5. `month` must be 1-12 or a valid short month name
6. `year` >= 2000

---

## UI Architecture (Electron + HTTP API)

The desktop UI uses a hybrid architecture:

### Electron Main Process (`ui/main.js`)

1. **Single-instance lock** -- `app.requestSingleInstanceLock()` prevents multiple UI instances
2. **HTTP API server** -- A `http.createServer` on port 3456 handles:
   - Static file serving (index.html, renderer.js, styles.css) with correct MIME types
   - REST API endpoints for all script operations
3. **BrowserWindow** -- Loads `http://127.0.0.1:3456` with `nodeIntegration: false` and `contextIsolation: true`
4. **Script lifecycle** -- `startScript()` spawns the automation process, `stopScript()` writes a signal file + fallback `taskkill`
5. **Chrome management** -- `connectChrome()` probes the CDP port, tries multiple Chrome executable paths, waits up to 10s for the port to open
6. **Log buffer** -- In-memory string buffer (max 500KB) that captures stdout/stderr from the child process. Detects `[BROWSER_CLOSED]` markers.

### Renderer (`ui/renderer.js`)

- Pure browser JavaScript, no Node.js APIs
- All communication via `fetch()` to the local HTTP API
- Polls status and logs every 2 seconds (`setInterval`)
- Updates button states (disabled/enabled) based on running status
- Shows/hides the browser-closed banner based on `browserClosed` and `stoppedByBrowser` flags
- Pulsing animation on Connect Chrome / Start buttons when browser closure is detected

### UI Layout (`ui/index.html`)

Two-column responsive grid:
- **Left panel:** Config display, action buttons, retry time control
- **Right panel:** Live log stream with monospace `<pre>` element
- Collapses to single column on screens < 980px

---

## Supabase Telemetry

Optional event logging. Events are fire-and-forget; failures are silently caught.

| Event Type | When Sent |
|---|---|
| `login_submitted` | After filling and submitting the login form (upserted — updates timestamp if same user+system already exists) |
| `calendar_visible` | When the calendar appears after city selection (includes available dates) |
| `submit_clicked` | Before clicking the submit button |
| `checkpoint_loaded` | When a checkpoint is loaded at startup |
| `schedule_403` | On HTTP 403 from the schedule API |
| `schedule_429` | On HTTP 429 from the schedule API |
| `ofc_submitted` | After successful OFC appointment submission |
| `consular_submitted` | After successful consular appointment submission |
| `appointment_submitted` | After full appointment success (OFC + consular) via `sendMajorEventAlert` |

Each event includes hostname, timestamp, and context-specific payload.

### Login Event Deduplication

`upsertLoginEvent()` in `supabase.ts` prevents duplicate login rows:
1. Queries the `events` table for an existing `login_submitted` row matching the same `username` (from payload) and `system` (hostname)
2. If found → updates the `created_at` timestamp and payload
3. If not found → inserts a new row
4. Falls back to insert if the query fails

A secondary local dedup file (`artifacts/state/login-sent.json`) avoids even querying Supabase if the event has been sent before on this machine.

---

## Client vs Dev Build Modes

The application supports two build modes with different log verbosity and UI behavior:

| Aspect | Dev Mode | Client Mode |
|---|---|---|
| **Core logs** | All `[INFO]`, `[WARN]`, `[ERROR]` with full detail | Only `client()` calls with emoji prefixes |
| **DevTools** | Opens automatically (`openDevTools({ mode: 'detach' })`) | Disabled (`devTools: false`) |
| **Debug panel** | Visible | Hidden |
| **Error logs** | `[ERROR]` prefix | `❌` emoji prefix (always shown) |

### How It Works

- `src/logger.ts` checks `process.env.IVAC_BUILD_MODE` (injected at compile time by esbuild)
- In client mode: `info()` and `warn()` are suppressed; `error()` is reformatted with `❌`; `client()` is always shown
- In dev mode: all functions work normally; `client()` calls are also shown (prefixed with emoji)

### Build Commands

```bash
# Dev build (full logs, DevTools, debug panel)
npm run build:dev
# or: node scripts/build-release.mjs --mode=dev

# Client build (clean logs, no DevTools, no debug panel)
npm run build:client
# or: node scripts/build-release.mjs --mode=client
```

### Build Pipeline

1. `build-release.mjs` reads `--mode=dev|client` argument
2. Sets `IVAC_BUILD_MODE` env var for `protect.mjs`
3. `protect.mjs` injects `process.env.IVAC_BUILD_MODE` as a compile-time constant via esbuild `define`
4. For client builds: `build-release.mjs` modifies `ui/main.js` (removes `openDevTools`, sets `devTools: false`) and `ui/renderer.js` (hides debug panel)
5. UI files are restored after electron-builder finishes (existing backup/restore pattern)

---

## Network Monitoring

The `monitorNetwork` function attaches to page `request` and `response` events:

- **Always logs:** HTTP responses with status 403, 429, 500, 502, 503, 504 (as WARN)
- **Always logs:** Any HTTPS response with status >= 400 (as WARN)
- **Debug mode (`debugNetwork: true`):** Logs all XHR/fetch requests and responses

---

## Dependencies

| Package | Type | Purpose |
|---|---|---|
| `patchright` | Runtime | Stealth Playwright fork for browser automation |
| `@supabase/supabase-js` | Runtime | Telemetry event logging and license validation |
| `tsx` | Dev | TypeScript execution for development |
| `typescript` | Dev | Type checking and compilation |
| `@types/node` | Dev | Node.js type definitions |
| `@yao-pkg/pkg` | Dev | Single-exe packaging |
| `electron` | Dev | Desktop UI launcher |
| `electron-builder` | Dev | Electron packaging for distribution |
| `esbuild` | Dev | JavaScript bundling and minification |

Note: `playwright` has been removed. Only `patchright` is used. `javascript-obfuscator` was removed (breaks Playwright). The build process marks `playwright`, `playwright-core`, and `electron` as external dependencies to be supplied by node_modules at runtime.

---

## Files to Update When Behavior Changes

- `ARCHITECTURE.md` -- this file
- `README.md` -- user-facing documentation
- `AGENTS.md` -- product improvement notes and repository guidance
- `config.example.json` -- example config template
- `src/config.ts` -- `AutomationConfig` type, parsing, and validation
- `src/index.ts` -- orchestrator loop, state machine, recovery, city rotation, direct API integration
- `src/api-direct.ts` -- Fast Flow module (page-function-based OFC booking)
- `src/ofc-schedule.ts` -- OFC page interactions, city selection, submission
- `src/consular-schedule.ts` -- consular stage scheduling
- `src/cloudflare.ts` -- verification detection and auto-solve
- `src/calendar.ts` -- calendar interaction and date selection
- `src/schedule-api.ts` -- API response interception and parsing
- `src/license.ts` -- License validation and management
- `src/login-dedup.ts` -- Login deduplication
- `ui/main.js` -- UI backend and API endpoints
- `ui/renderer.js` -- UI frontend logic
- `scripts/build-release.mjs` -- Release build pipeline
- `scripts/protect.mjs` -- Code protection strategy
