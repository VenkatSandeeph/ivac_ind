# IVAC Launcher -- Product Improvement Notes

> **Docs map:** `docs/architecture.md` (system + Mermaid diagrams), `docs/desktop.md`, `docs/mobile.md` (Android app), `docs/operations.md` (build/debug commands), `docs/known-issues.md` (open investigations), `mobile_session/AGENTS.md` (Android product notes — this doc's counterpart). Agent workflow skills: `.devin/skills/` (`ivac-repo`, `ivac-desktop`, `ivac-mobile`, `ivac-mobile-debug`).

## Current Architecture Summary

The IVAC Launcher is an Electron-based desktop application that automates visa appointment booking on `usvisascheduling.com`. It uses a 3-tier direct API approach for fast OFC appointment submission, with fallback to DOM automation.

### Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Main orchestrator -- infinite loop, state machine, city rotation, direct API integration |
| `src/api-direct.ts` | 3-tier direct API: jQuery $.ajax (Tier 1), raw XHR (Tier 2), fast DOM + capture (Tier 3) |
| `src/ofc-schedule.ts` | OFC page DOM interactions -- city selection, time slot selection, submit |
| `src/consular-schedule.ts` | Consular stage scheduling (after OFC success) |
| `src/calendar.ts` | Calendar month/year manipulation, date cell clicking |
| `src/schedule-api.ts` | Network response interceptor for getScheduleDays |
| `src/browser.ts` | Chrome launch, CDP connection, port probing |
| `src/auth.ts` | Login form detection and credential entry |
| `src/cloudflare.ts` | Turnstile/CAPTCHA detection and auto-solve |
| `src/checkpoint.ts` | Crash recovery state persistence |
| `src/config.ts` | Config loading, validation, type definitions |
| `src/nordvpn.ts` | NordVPN CLI-based IP rotation (machine-wide, file lock + cooldown) |
| `src/telegram.ts` | Telegram channel notification on OFC success (fire-and-forget, hardcoded creds) |
| `src/license.ts` | Supabase-based license validation |
| `src/login-dedup.ts` | Login deduplication for multi-tab scenarios |
| `src/slot-tracker.ts` | Local JSONL recorder for calendar visibility observations (fire-and-forget) |
| `src/beep.ts` | Dual beep alert for calendar visibility (shared by OFC + consular stages) |
| `ui/main.js` | Electron main process, HTTP API server, script lifecycle |
| `ui/renderer.js` | Electron renderer, UI frontend logic |
| `scripts/build-release.mjs` | Full release build pipeline |
| `scripts/protect.mjs` | esbuild bundling + minification |

### Direct API 3-Tier Approach

The direct API module (`src/api-direct.ts`) uses 3 tiers to submit appointments fast:

1. **Tier 1: jQuery `$.ajax()`** (~600ms) -- Uses the page's own jQuery, inheriting all configured headers and tokens. Most reliable.
2. **Tier 2: Raw XMLHttpRequest** (~600ms) -- Fallback when jQuery unavailable. Manually sets headers.
3. **Tier 3: Fast DOM + response capture** (~2-3s) -- Clicks date cell, captures page's own API response, submits via DOM. Zero extra API requests.
4. **Fallback: Standard DOM flow** (~7-10s) -- Full DOM rendering waits. Most reliable but slowest.

### Submit Failure Handling (fast-flow contention)

Observed during a real slot drop (NEW DELHI, :56 window): submits returned HTTP 200 `HasError` — "The selected appointment time is no longer available" — after **14-25s** of server-side latency, and the page itself then fired a **fresh `getScheduleEntries` + its own auto-resubmit** of the dead slot.

- **`slot_gone` classification** — `submitViaPageFunction` tags that error `code:'slot_gone'`. The success path is untouched (`responseTimeoutMs` stays 60s/30s — loaded servers deliver success slowly; failures already arrive fast via their error response).
- **Same-date retry** — on `slot_gone`, `runDomFastFlow` waits for in-flight submits to drain (`waitForSubmitQuiesce`, 8s), grabs the page's post-failure entries refresh (`waitForNextEntriesCapture` via `entriesCaptureGen`), and submits **one** different seat-eligible slot on the same date before moving on.
- **In-flight tracking** — `pendingOfcSubmits` counts `appointments-for-family` requests (increment on request, decrement on response or `requestfailed`) so retries/wire replay never race the page's own auto-resubmit.
- **Wire replay gating + fresh token** — `runWireBookingFlow` now waits for submit quiesce (8s) and prefers `capturedEntriesToken` over the days-level `capturedScheduleToken`; the stale days token caused `PSE0601` on every wire call.

### Adaptive Entries Wait + Late-Entries Rescue

Observed during a slot drop (NEW DELHI, :56 window): the days call took 21s under server load, the entries response took ~17s, but the fixed 8s Phase-2 wait gave up at second 8 — **5 bookable entries arrived 9s after the timeout and were orphaned** while the loop idled in the inter-city wait.

- **Request-aware wait** — `entriesRequestGen` tracks getScheduleEntries *requests* (not just responses). `clickDateAndGetEntries` first waits ~3s for a request to fire: no request → dead click → bail immediately (faster than the old 8s). Request seen → the response is guaranteed, just slow → wait `min(30s, max(15s, 1.5 × lastDaysLatencyMs))` where `lastDaysLatencyMs` is the just-measured days-call round-trip. Waits resolve the instant the capture lands, so fast responses are never slowed — only the ceiling moved.
- **Late-entries rescue** — when the adaptive wait expires with the request still in flight, `lateEntriesRescue` is armed (`{date, sinceGen}`). The `all_exhausted` inter-city wait then runs `consumeLateEntriesRescue` concurrently with the normal sleep: if the late response lands before the deadline, the rescue waits for submit quiesce, verifies the page is still on OFC context (or already on consular → count as booked), and submits one seat-eligible slot via `submitViaPageFunction` with the captured token — same sort/filter logic, no extra API calls. After the sleep, a bounded 25s settle race lets a mid-flight rescue submit finish.
- **Hard boundary** — `postId` is per-city; the capture dies at the next `selectCity`. `resetCapturedScheduleData()` (called before every city selection) clears `lateEntriesRescue`, so nothing can ever be submitted against the next city's context. Rescue is single-shot per city.
- **Special-window waits do NOT arm the rescue** — `preciseSleepUntilSpecialWindow` must fire selection exactly on the trigger; a rescue submit mid-window would risk missing it.

**Lessons learned:** the page auto-refreshes entries after a failed submit (a stale-token assumption was wrong); submit failures are contention losses, not bugs — act on the error response, don't shorten the success timeout; wire replay must never run against a session with submits in flight; a captured-but-unconsumed response is a wasted slot — listen during dead time, and discard the capture the instant the city context dies.

### EXPERIMENTAL: avoidEarliestDate ("2nd Date" header toggle)

Theory: bots concentrate on the earliest available date, so the 2nd-earliest sees less submit contention. When ON (`settings.avoidEarliestDate`, per-profile override supported) and ≥2 in-range dates exist with the 2nd within **7 working days** of the earliest, the attempt order becomes `[2nd, 1st, 3rd, ...]` — the earliest stays the immediate fallback in the same attempt (reorder, never skip). Applied at one seam — `orderDatesForAttempt` in `src/api-direct.ts` — used by the fast flow (`matchingDates`), the DOM path (`candidateDates`, both call sites), and the consular sweep (`candidateDates` in `consular-schedule.ts`, events tagged `path:'consular'`). Working days = Mon–Fri only (no holiday calendar). All edits are marked `// EXPERIMENTAL`; removal = delete marked blocks + the config key + `src/date-experiment.ts`.

**Experiment logs** (`src/date-experiment.ts` → `logs/date-experiment.jsonl`, fire-and-forget, serialized write queue): `decision` events record every ordering choice — `dates`, `gapWorkingDays`, `enabled`, `wouldReorder` (baseline: fires even when the toggle is OFF, so you can see how often the rule *would* have applied), `reordered`, `order`. `outcome` events per attempted date: `pos` (position in attempt order), `promoted` (tried-first 2nd date), `result` (`booked`/`booked_retry`/`slot_gone`/`throttled`/`no_entries`/`no_eligible`/`submit_error`/`error`/`hard_error`). Join on `runId`+`attempt` (dom) or `postId`+timestamp (fast). Analysis: `findstr "promoted\":true" logs\date-experiment.jsonl` → compare booked-rate of promoted vs non-promoted attempts.

### Per-profile City Selection Log

`src/city-selection-log.ts` appends one line per OFC city selection to `logs/ofc-city-selections-<profile>.txt` (append-only, survives restarts):

```
[2026-10-12] [14:23:41] Selected NEW DELHI VAC | Calendar Visible: true
```

Called from `logCitySelected` in `src/index.ts` — the choke point all OFC selectCity + schedule-response sites use (consular stage does not write this file). Fire-and-forget with a serialized write queue — never blocks the booking loop. Filename is `config.username` sanitized (`[^\w.-]` → `-`); profiles sharing a username share one file.

### Consular Stage (post-OFC booking)

`src/consular-schedule.ts` — after OFC is booked the script lands on `/en-US/schedule/`. The stage sweeps **all** configured consular cities each cycle (2–4s gap between selects), then waits `consular.cityRetrySeconds` (default 15s, per-profile `consular` block or settings `consularCityRetrySeconds`) before the next sweep. Same DOM contract as OFC (`#post_select`, `#datepicker`, `#time_select`, `#submitbtn`, `jsdata.Num`) so `ofc-schedule.ts`/`calendar.ts` helpers are reused; only the routes differ (`get-family-consular-schedule-days/-entries`, `schedule-consular-appointments-for-family`). City names have no " VAC" suffix — stripped at config merge.

- **Config**: profile `consular: {city[], startDate, endDate, cityRetrySeconds}` — all optional. Empty cities → OFC cities minus ` VAC`; empty dates → **earliest available** (unbounded): the site only renders dates it considers bookable — it never shows dates before the booked OFC — so the sweep takes the earliest green cell. The calendar month jump targets the earliest day from the `schedule-days` response (`lastConsularDaysDates`), falling back to the OFC configured month. UI: Consular section in the profile editor.
- **UI status**: the consular-stage status label reads `Consular — OFC: <M/D/YYYY h:mm AM>` — scraped ONCE per process from the page's `ofcAppointments[0].appointmentDateStr` global (cached in `ofcAppointmentCache`), re-emitted each sweep so heartbeats can't drop it permanently. The global lives in the MAIN world — the scrape goes through `evalInMainWorld()` (CDP `Runtime.evaluate`) because Patchright's `page.evaluate` runs in an isolated world where page globals are invisible. Fallback: plain `Consular` when the global is absent.
- **Response-aware submit**: `submitConsular` arms a `schedule-consular-appointments-for-family` response listener before clicking — `HasError` verdicts return in ~1–3s instead of the old 60s nav-wait stall; `AllScheduled` → confirmation page → `sendConfirmationPdfToTelegram` (local `artifacts/confirmations/` PDF + Telegram doc).
- **Seat eligibility**: consular `validateData` only checks `jsdata.Num` — candidates are filtered client-side to `avail >= applications.length` (page global populated by the members query).
- **Not ported**: the OFC 3-tier direct API and wire replay are OFC-only — consular is DOM + response capture (same as the OFC DOM fallback).

### Special Windows (slot-drop timing)

`SPECIAL_WINDOW_TRIGGERS_SEC` in `src/index.ts` — observed slot-drop trigger times at **second :58** of minutes **12, 25, 29, 36, 49, 55, 59**, every hour, on the **local system clock** (fires when the machine's time hits `HH:MM:58`; NOT server UTC).

- `computeRetryDelay` shortens the normal city-retry delay when a trigger falls inside it, so the selection fires **exactly at `:MM:58`** (`preciseSleepUntilSpecialWindow`, ~ms precision via coarse 500ms + 1ms sleep ticks). Triggers that expire mid-work (API wait, recovery) are simply missed — the cadence never pauses for a trigger. Between-date-attempt waits pass `alignToTrigger=false` — never stall an open calendar.
- **Multi-city sweep**: when a trigger-aligned selection fires and >1 city is configured, `beginSpecialSweep` queues **all** desired cities (rotation order, wrapped from the next city). While the queue is non-empty: city picks come from the queue, retry gaps drop to a random **2-4s**, and `scheduleWaitMs` is capped at **60s**. A >60s response aborts the whole sweep (`abortSpecialSweep`); booking fails continue the sweep; when the queue drains, normal city retry resumes at the same rotation position.
- `inSpecialWindow` marks trigger−20s → trigger+150s as "busy": `scheduleWaitMs` extends the schedule-API wait to 75s (a slow response during a drop is server load, not a dead request) and 403/429 strikes inside a window do not count toward IP rotation. The `:59:58` window tail wraps past the hour boundary (mod-3600).

### NordVPN IP Rotation Architecture

The NordVPN module (`src/nordvpn.ts`) provides machine-wide IP rotation using the NordVPN Windows CLI. All running profiles share ONE IP — a block on one profile affects all profiles simultaneously.

**How it works:**

```
All ivac-core processes (all profiles share one IP)
  → NordVPN desktop app (must be running + logged in)
  → nordvpn -d  (disconnect)
  → nordvpn -c -g "<city>"  (random pick from nordvpn-cities.json — verified working form)
  → new residential IP
```

- `rotateNordVpn(config)` runs `nordvpn -d` then `nordvpn -c -g "<city>"` via child_process (city names are valid `-g` groups on this build — verified; the documented positional `-c <country> <city>` form is silently ignored → quick-connects to fastest/India, do NOT use it).
- Rotation picks cities **randomly** from `nordvpn-cities.json` (187 user-curated working entries, verified against api.nordvpn.com): ~70% weighted to the `hubs` pool (93 low-latency US/Canada/Europe exits) and ~30% to `rest` (94 worldwide exits). Each process consumes a **shuffle bag** — no repeats until the pool drains. A shared `.ivac-nordvpn-recent` file (last 10 attempted cities) keeps multiple profiles from re-picking the same exits. Each failed/no-new-IP attempt picks another random city (max 5 per rotation), then falls back to a **country-group connect** (`nordvpn -c -g <country>`) for the last-attempted country — never bare Quick Connect (that lands on the fastest server, e.g. India, ignoring the curated pool).
- After connect, verifies the public IP changed (queries `api.ipify.org`) AND **geolocates it via ip-api.com** — the new IP's country must match the target (mismatch → rejected → next city). The CLI prints no stdout, so geo is the only proof the connect honored the target.
- File lock (`.ivac-nordvpn.lock`) prevents concurrent rotations across multiple core processes. The holder **heartbeats** the lock mtime every 10s — a real rotation takes 2-4 min, far past the 60s stale window, so a live lock is never mistaken for a dead one.
- A process that finds the lock held **waits up to 45s** for the other rotation to finish; if `.ivac-nordvpn-current-ip` updates during the wait, it reuses the new shared IP and skips its own rotation.
- 2-min cooldown (`.ivac-nordvpn-cooldown`) prevents cascading rotations from stale block signals.
- Current IP written to `.ivac-nordvpn-current-ip` for UI display. `ipRotatedSince(ts)` lets callers detect a rotation completed by another process — every strike-ladder rotation site checks it before rotating, so one profile's rotation resolves the block for all profiles instead of each rotating in turn.

**Rotation triggers:**
- **Hard blocks** — `isHardBlocked` classifies the page (`recoverFromBlockPage`):
  - **Access limitation**: clear browser cache (cookies preserved — session survives) → rotate IP → reload → re-solve Turnstile.
  - **Cloudflare "You are blocked"** (CF 1020): **two-stage** — wait 30s → navigate to home page → re-check. Rotate **only if still blocked**: cache clear → rotate once → navigate home.
  - **Rate limited** (CF 1015): transient — 60s backoff on the same IP, **no rotation**.
- **403/429 from schedule API**: the page is checked for a hard block FIRST (a 403/429 often redirects the tab to a block page — that path runs `recoverFromBlockPage`, not the soft-strike flow). Otherwise **three-strike** — strikes 1-2 recover via home page, strike 3 rotates. Suppressed inside special windows (server load, not an IP ban).
- **Navigation timeouts** during home recovery wait 2-3 min and retry — NOT treated as blocks.
- **Consular 403**: three-strike using the existing `consecutive403` counter.
- **No periodic timer** — rotation is block-triggered only.

**Config fields** (in `config.local.json` settings):
- `nordvpn.exePath` — NordVPN CLI path (default `C:\Program Files\NordVPN\nordvpn.exe`)
- `nordvpn.connectTimeoutMs` — connect timeout (default 30000)
- `nordvpn.ipCheckUrl` — IP verification endpoint (default `https://api.ipify.org`)
- Env var override: `NORDVPN_EXE_PATH`, `NORDVPN_CONNECT_TIMEOUT_MS`

**Key functions in `src/nordvpn.ts`:**
- `rotateNordVpn(config)` — main rotation: disconnect → connect → verify IP → write cooldown
- `disconnectNordVpn(exePath)` / `connectNordVpn(exePath, timeoutMs)` — individual commands
- `getCurrentPublicIP(ipCheckUrl)` — fetch current public IP
- `isCooldownActive()` / `isRotationLocked()` — lock/cooldown status checks
- `ipRotatedSince(ts)` — true when another process completed a rotation after `ts` (mtime of `.ivac-nordvpn-current-ip`)
- `pickCityTarget(recent)` — weighted shuffle-bag picker over `nordvpn-cities.json`

**UI behavior:**
- Single "Rotate IP" button in the header (topbar) — global, not per-profile.
- `main.js` delegates manual rotation to `ui/nordvpn-rotate.js` — a CommonJS port of `src/nordvpn.ts` that honors the same lock (waits up to 60s for an in-progress core rotation and reuses its result), the same city pool/recent files, and writes the shared cooldown so cores back off afterward.
- `/api/rotate-ip` (POST) — runs disconnect + connect + IP check, returns new IP.
- `/api/current-ip` (GET) — reads `.ivac-nordvpn-current-ip` file.
- Current IP polled every 15s and displayed in the button subtext.

**Important caveats:**
- **Disable NordVPN kill switch** before using this automation — kill switch blocks ALL internet during disconnect→reconnect.
- **NordVPN app must be running and logged in** — the CLI talks to the desktop service.
- **All profiles share one IP** — a block on one profile blocks all profiles.
- **Rotation disrupts all profiles** — during disconnect→reconnect (10-30s), all Chrome instances lose network.
- **City pool is shared, picks are per-process.** `nordvpn-cities.json` is read once per process; the shuffle bags are in-memory (each process sees a different random order). Cross-process dedup comes from `.ivac-nordvpn-recent`, not a shared pointer.
- **Initial check on first profile start** — verifies NordVPN exe exists. Subsequent starts skip the check.

### IP Modes & Static Proxy Relay (Static IP)

The UI's `IP Mode` dropdown (`ui/index.html`) selects `ipMode: 'none' | 'auto' | 'static'` per profile (`src/config.ts`). `none`/`auto` map to legacy `autoRotateIp` false/true (kept mirrored for compat; `ipMode` wins when both present). Effective mode: `profile.ipMode ?? settings.ipMode`.

`static` mode (`src/static-proxy.ts`) launches Chrome through a **local CONNECT relay** (`127.0.0.1:<debugPort+10000>`, e.g. 9222→19222) that tunnels every request to the currently selected upstream proxy from `proxies.txt` (project root, gitignored; `host:port:user:pass` per line, `#` comments, optional `http://`/`socks5://` prefix — only `http` is implemented; `dialUpstream` is the seam to extend).

- **Round-robin**: shared `.ivac-proxy-index` (project root) + `.ivac-proxy-lock` O_EXCL spin — all running profiles advance one global pointer; each rotation verifies the candidate (`CONNECT api.ipify.org:443` → logged egress IP), skipping dead proxies with a full-cycle circuit breaker.
- **Rotation triggers**: all `rotateNordVpn` call sites route through `rotateEgress()` in `index.ts` — `auto`→NordVPN, `static`→`relay.rotate()`. Strike ladders unchanged.
- **Manual Rotate IP**: `ui/main.js` `/api/rotate-ip` writes `.ivac-rotate-static` flag → core polls it each loop iteration (OFC and consular loops) → `relay.rotate(manual)`. Observed IP lands in `.ivac-static-last-ip` for the button subtext.
- **Existing-Chrome mismatch**: on start, if `chrome-debug-<port>` is up but `.ivac-relay.json` marker (inside userDataDir) is absent/mismatched → kill + relaunch proxied. CDP `/json` close first, `netstat` PID fallback.
- **Stop**: `gracefulStopForStatic()` kills Chrome + relay, waits for the debug port to close (`waitForPortClosed` in `utils.ts`), respawns Chrome **direct** so the still-open session stays usable. The taskkill /F emergency path cannot be intercepted.
- **Caveat**: only Chrome traffic is proxied — node-side calls (license, Telegram, Supabase) go direct even in static mode (unlike NordVPN which is machine-wide). Each static profile gets its own egress; Decodo-style ports are sticky sessions (port 10001 = one IP).
- `test-static-proxy.js` (root, dev tool, needs `npm run build` first) exercises parse → verify → relay → rotate end-to-end.

### Telegram OFC Success Notification

The Telegram module (`src/telegram.ts`) sends a formatted HTML message to a hardcoded Telegram channel when OFC is successfully submitted.

**How it works:**
- Fire-and-forget async call (`.catch(() => null)`, no `await`) — never blocks the booking loop.
- Uses Telegram Bot API `sendMessage` with HTML parse mode.
- Credentials are hardcoded (same pattern as Supabase). Placeholders by default — fill in before building.
- Auto-detect: if credentials are still placeholders, notifications are skipped silently.

**Trigger points:**
- Direct API OFC success (`src/index.ts` ~line 1193)
- DOM flow OFC success (`src/index.ts` ~line 1910)
- Resume on consular page (prior session) — NOT triggered (OFC was booked in a previous run).

**Message format (HTML):**
```
✅ OFC Appointment Booked

👤 User: john_doe
🏙 City: HYDERABAD VAC
📅 Date: 2026-10-15
⏰ Time: 10:00 AM
🕐 Booked At: 2026-09-21 08:53 UTC
```

**Config:** None — credentials are hardcoded in `src/telegram.ts` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`). If placeholders are present, notifications are skipped silently.

**Future:** Calendar visibility notification (send all available dates when calendar appears) is deferred — needs throttling/rate-limit design to avoid channel flooding.

### Build Outputs

Recent releases are in `release<N>/win-unpacked/` and `release<N>/IVAC-Launcher.zip`. The build script uses a temporary `scripts/build-release-temp.json` (deleted after build) to configure Electron Builder.

### Known Build Issues

- **winCodeSign symlink error**: Electron Builder cannot create Darwin symlinks on non-elevated Windows. The build continues because the unpacked app and ZIP are still created. Code signing is NOT performed.
- **eval('require') warning**: `src/browser.ts` uses `eval('require')` for pkg compatibility. esbuild warns about this but it's required for runtime module resolution.
- **UI obfuscation disabled**: javascript-obfuscator breaks Electron UI event handlers. UI files are not obfuscated.

### Temporary Diagnostic Logs

Logs marked with `[TEMP LOG]` in `src/api-direct.ts` are temporary diagnostics for the direct API development phase. They should be removed once the direct API flow is verified working in production. Search for `[TEMP LOG]` to find them.

### Slot Observation Tracking (Calendar Visibility Logger)

The slot tracker (`src/slot-tracker.ts`) records every calendar visibility event (OFC + consular) to a local JSONL file for pattern analysis of appointment release dates and times.

**Key design:**
- **Fire-and-forget**: `recordSlotObservation()` returns `void` and never blocks the booking loop. The internal `fs.appendFile` is `.catch()`-ed to swallow all errors. Recording must NEVER break or slow the booking flow.
- **Single shared JSONL file**: all profiles write to `logs/slot-observations.jsonl` with a `profile` field for filtering. Append-only, grep-able, imports to Excel/Python/Sheets.
- **Records both OFC and consular stages**: each observation includes the stage, city, visible dates, API state, and configured range.

**Output file:** `logs/slot-observations.jsonl` (one JSON object per line)

**Record schema:**

| Field | Type | Description |
|---|---|---|
| `timestamp` | string (ISO 8601) | UTC timestamp of observation |
| `profile` | string | `config.username` — identifies which account observed this |
| `runId` | string | Run identifier from `index.ts` (or `consular-<timestamp>` for consular stage) |
| `stage` | `'ofc'` \| `'consular'` | Which scheduling stage |
| `city` | string | City being checked when the calendar became visible |
| `url` | string | Page URL at time of observation |
| `availableDates` | string[] | Green (available) dates on the visible calendar month |
| `inRangeDates` | string[] | Dates within the configured `startDate..endDate` range |
| `configuredRange` | object | User's configured `{ startDate, endDate, month, year }` |
| `apiScheduleDays` | number | Count from schedule API response (0 if no API response) |
| `apiScheduleEntries` | number | Count from schedule API response (0 if no API response) |
| `apiAvailable` | boolean \| null | API availability result (null if no API response) |
| `calendarMonth` | string \| null | Best-effort calendar month label (e.g. "October 2026"); null if not extracted |

**Hook points:**
- **OFC stage** (`src/index.ts`): after `waitForCalendarReady()` succeeds and `getDatesWithAllAvailable()` returns. Records the current city and any alternate cities tried during multi-city rotation.
- **Consular stage** (`src/consular-schedule.ts`): after `waitForCalendarReady()` succeeds and `getDatesWithAllAvailable()` returns.

**Dual beep on calendar visibility:**
- `playBeep()` (in `src/beep.ts`) fires the moment the calendar becomes visible — right after `waitForCalendarReady()` succeeds — regardless of whether any dates fall in the configured range.
- Previously, the beep only fired when in-range dates were found. Now it fires on calendar visibility itself, giving earlier alert.
- Windows only; no-op on other platforms. Fire-and-forget (detached PowerShell process).

**To analyze the data:**

```powershell
# All observations for a specific city
findstr "HYDERABAD" logs\slot-observations.jsonl

# All OFC-stage observations
findstr "\"stage\":\"ofc\"" logs\slot-observations.jsonl

# Import to Excel: use Power Query (Data > From File > JSON)
# Or quick Python:
# python -c "import json; [print(json.loads(l)['timestamp'], json.loads(l)['city'], json.loads(l)['availableDates']) for l in open('logs/slot-observations.jsonl')]"
```

### Slot Pattern UI (in-app viewer)

The "Slot Pattern" button in the topbar (next to "Edit Profiles") opens a popup modal showing the most recent 50 calendar visibility observations in a sortable table.

**UI components:**
- **Button** (`#slotPatternBtn` in `ui/index.html`): opens the Slot Pattern modal.
- **Modal** (`#slotPatternModal` in `ui/index.html`): displays a table with columns: Time (IST), Profile, Stage, City, Available Dates, In-Range, API.
- **City filter dropdown**: filters observations by city (All / specific city).
- **Refresh button**: reloads the latest 50 observations from the API.
- **Close button** (×) + backdrop click: closes the modal and restores focus to the dashboard.

**API endpoint:**
- `GET /api/slot-observations?limit=50` (in `ui/main.js`): reads the last N records from `logs/slot-observations.jsonl`, returns them newest-first as JSON. For large files, reads only the last 512KB to avoid memory issues.

**Timestamps:** All times are displayed in IST (UTC + 5:30) for easy pattern observation.

**Modal behavior:**
- When the modal is open, `appState.modalOpen = true` — this pauses profile list polling and status refresh (same pattern as Add/Edit Profile modals).
- Closing the modal sets `appState.modalOpen = false` — polling resumes.

---

## 1. Security & Trust
- **DPAPI-encrypt credentials.** Encrypt `password` and security-question `answer` fields before writing `config.local.json`. Plain-text credentials are a liability.
- **Remove `rejectUnauthorized: false`.** License REST calls should validate TLS certificates. The hardcoded Supabase key in `ui/main.js` should be replaced with a signed JWT or a customer validation backend.
- **Replace `selfDestruct` with deactivation-only.** Deleting the app folder is dangerous. A "terminated" license should simply refuse to start and show a message.
- **License seat binding.** Bind licenses to a machine + Windows user to prevent sharing.

## 2. Reliability & Operations
- **Persist per-profile logs.** Write `logs/profile-<id>.log` and support export/rotation.
- **Atomic config writes.** Save to `config.local.json.tmp` then rename. Keep `config.local.json.bak`.
- **Graceful shutdown.** Wait for `ivac-core` to exit gracefully before `taskkill /F`.
- **Build integrity.** Do not silently pass `winCodeSign`/packaging errors. Block builds on real failures. The winCodeSign symlink error is known and tolerated; other errors must be investigated.
- **Remove `[TEMP LOG]` diagnostics** from `src/api-direct.ts` once direct API is verified in production.

## 3. Multi-Profile & Scalability
- **Per-profile IP isolation.** Currently all profiles share one NordVPN IP (machine-wide VPN). Consider per-profile proxies (e.g. residential proxy service) if IP-level bans become a problem.
- **Concurrency limits.** Add `maxConcurrentProfiles` and per-profile resource hints.
- **Never-reused profile IDs.** Use `chrome-debug-<profileId>` instead of sequential numbers to avoid cross-contamination.
- **Staggered starts.** Randomize login times so all profiles don't hit Cloudflare simultaneously.
- **Per-profile Chrome data dirs.** Isolate Chrome user-data, stop signaling, checkpoints, and logs per profile.
- **Independent profile operation.** Profile 1 on port 9222, profile 2 on port 9223, etc. Each profile must be independently startable/stoppable.

## 4. User Experience
- **Profile validation.** Add "Test credentials" and "Test login" before running.
- **Screenshot gallery.** View and prune per-profile screenshots in the UI.
- **Auto-updater.** Use Electron `autoUpdater` or a custom in-app updater.
- **In-app help and tooltips.** Explain every field in the profile editor.
- **Profile status labels.** Each profile row should show: Login page, Cloudflare, Schedule page, Home Page, or Consular. (Done — `[UI_STATUS]` markers + heartbeats; consular shows `Consular — OFC: <date time>`.)
- **Profile `visaType` field.** Optional free-text in the profile editor (above the Appointment section) → `profile.visaType` in `config.local.json` → shown as `visatype: <value>` on the dashboard card. Display-only — the core never reads it.
- **Log switching.** Logs must update independently per running profile and be switchable in the Logs section.
- **Start/stop state accuracy.** UI state must reflect actual process state, including after duplicate-profile errors or deletion.

## 5. Compliance & Business
- **Terms-of-service disclaimer.** Add visible notice that automation may violate site TOS.
- **Human-in-the-loop mode.** Optional "find only, let me confirm" mode to reduce botting risk.

## 6. Development Quality
- **Test suite.** Add `vitest` or `mocha` for `loadConfig`, port allocation, and merge logic.
- **Remove `eval('require')`.** Replace with conditional `require` based on `process.pkg`.
- **CI build.** Run `tsc` and `npm run build:release` automatically on commit.
- **Consular direct API.** Complete the consular direct API implementation after observing/capturing the actual consular routes. The response capture groundwork is already in place.
- **Success notification.** Open the YouTube notification video only after BOTH OFC and consular stages succeed.
- **No continuous screenshots.** Do not continuously take screenshots during consular booking.

## 7. Direct API Development Notes
- **Avoid duplicate API calls.** The page's own `getScheduleDays` and `queryFamilyMembers` calls must NOT be duplicated. Use response capture instead.
- **Cloudflare HTML challenge detection.** HTTP 200 with HTML body (containing "Just a moment", "__cf_chl", "<html") should be treated as a Cloudflare block, not a parse failure.
- **Session-level blocking.** `directApiBlocked` should only be set for actual Cloudflare blocks (403/429/HTML challenge on `getScheduleEntries` or `submit`), NOT for context extraction failures or no-slots outcomes.
- **Initial delay before first XHR.** Wait 500-1000ms after the page's `getScheduleDays` before calling `getScheduleEntries` to avoid request burst detection.
- **jQuery-first approach.** Always try `window.jQuery.ajax()` before raw XHR. jQuery inherits all page-configured headers and tokens.
- **Fast DOM fallback.** When API calls are blocked, click the date cell to trigger the page's own `getScheduleEntries`, capture the response, and submit via DOM. This makes zero extra API requests.
- **The page auto-resubmits.** After a failed submit the site fires its own `getScheduleEntries` refresh AND a second submit of the dead slot. Always drain `pendingOfcSubmits` before our retry or wire replay.
- **Tokens are per-response.** Replay calls must use the freshest captured token (`capturedEntriesToken`), not the days-level token — a stale token returns PSE0601 with HTTP 200.

## 8. NordVPN Development Notes
- **Machine-wide VPN.** All running profiles share ONE NordVPN IP. A block on one profile affects all profiles. This is a fundamental tradeoff vs the old per-profile Decodo proxy.
- **File lock + cooldown.** `.ivac-nordvpn.lock` (exclusive-create, 60s stale break) prevents concurrent rotations. `.ivac-nordvpn-cooldown` (2 min) prevents cascading rotations from stale block signals.
- **Three-strike 403/429.** Before counting a strike the page is checked for a hard block (`isHardBlocked`) — a 403/429 that redirected the tab to an "Access limitation"/"You are blocked" page runs `recoverFromBlockPage` instead of home recovery. Strikes 1-2: go home and retry. Strike 3: rotate NordVPN — except inside a special window, where 403/429 bursts are server load (IP held, window exit re-checks). Counter resets on any non-403/429 response.
- **Hard blocks are staged.** Access limitation → clear browser cache (cookies preserved) + rotate + reload immediately. "You are blocked" (CF 1020) → wait 30s + navigate home first; only if still blocked: cache clear + rotate once. Rate-limited pages (CF 1015) just back off 60s — no rotation. Navigation timeouts wait 2-3 min + retry, never count as blocks.
- **Ordered city rotation.** `nordvpn -c -g "<city>"` walks CITY_ROTATION_SEQUENCE: US (55 cities) → UK (4) → France (4) → Denmark (1) → Czech Republic (1) → Papua New Guinea (1) → Costa Rica (1), then wraps. Each connect is **geo-verified via ip-api.com** — a wrong-country exit (e.g. Quick Connect sneaking to India when an arg is ignored) is rejected and the walk advances (max 5 per rotation), then a `-c -g <country>` group connect for the last-attempted country is the final fallback. Position is in-memory per process.
- **NordVPN app must be running + logged in.** The CLI (`nordvpn.exe`) talks to the NordVPN desktop service. If not running/logged in, rotation fails gracefully (returns `rotated: false`).
- **Disable NordVPN kill switch.** If kill switch is enabled, disconnect blocks ALL internet until reconnect completes, extending the disruption window significantly.
- **Initial check on first profile start.** `main.js` verifies `nordvpn.exePath` exists before starting the first profile. Subsequent starts skip the check.
- **UI and cores coordinate via the shared files, not signals.** `main.js` rotates via `ui/nordvpn-rotate.js` using the same lock/cooldown/recent files as `src/nordvpn.ts`; cores run NordVPN directly for block-triggered rotation.

## 9. Android App (mobile_session/)

A standalone Kotlin app (`com.ivac.mobile`) that ports the booking state machine into an embedded WebView — no PC/VPS/ADB at runtime. See `docs/mobile.md` for the full reference and `docs/operations.md` for the vendored-toolchain build commands.

**Key points for anyone modifying it:**

- `Engine.kt` is a deliberate port of `src/index.ts` semantics — keep parity: API `ScheduleDays` is authoritative, 403/429 strikes → VPN rotate → pause+notify. (Desktop `dryRun` was removed — desktop always submits; mobile still supports it.)
- `Driver` interface (`Engine.kt` top) is the only engine↔UI seam — `MainActivity` implements it.
- VPN is **embedded WireGuard/NordLynx only** (`VpnManager` + `NordProvisioner` + `com.wireguard.android:tunnel`). The external OpenVPN-app path was deliberately removed — do not reintroduce.
- `Store` encrypts profiles/settings with AES-256-GCM in AndroidKeyStore. Never log `wg_privkey`, `nord_token`, `tg_token`, or passwords.
- `A11yService` exists solely to inject genuine taps into the cross-origin Turnstile iframe — coordinate mapping in `MainActivity.tap()` is under investigation (`tapdbg` diagnostic; see `docs/known-issues.md` #1).
- Profiles merge on import by id/username, preserving `dryRun`/`enabled`/`cityRetrySeconds`.
- One profile runs at a time; `running_profile` setting auto-resumes after recreation.

## Implementation Priority
1. Security hardening (credential encryption, license binding).
2. Reliability (logs, config, graceful shutdown, build integrity).
3. Direct API verification (remove temp logs, verify all 3 tiers work).
4. Consular direct API implementation.
5. Multi-profile UI + config editor.
6. ~~Proxy/concurrency features.~~ **NordVPN IP rotation implemented** — machine-wide VPN with heartbeat lock + 2-min cooldown, weighted-random picks from `nordvpn-cities.json` + shared recent-city dedup, `ipRotatedSince` cross-profile detection, three-strike 403/429, staged hard-block recovery. Concurrency limits pending.
7. Auto-updater.
