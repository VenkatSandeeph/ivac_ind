# Android App — Architecture & Internals

`mobile_session/app/` — a standalone Kotlin app that runs the same booking loop as the desktop core, inside an embedded WebView. No PC, VPS, or ADB needed at runtime. Package `com.ivac.mobile`, minSdk 24 / targetSdk 34, JDK 17, Gradle 8.9 (see `docs/operations.md` for the local toolchain layout). Product improvement notes for this app live in `mobile_session/AGENTS.md` (the Android counterpart of the root `AGENTS.md`).

## App shell

Three activities + three services, all declared in `AndroidManifest.xml`:

| Component | Exported | Purpose |
|---|---|---|
| `MainActivity` | yes (launcher, `singleTask`, all `configChanges` handled) | WebView host, `Driver` impl, profile list, log pane, engine lifecycle |
| `ProfileActivity` | no | Minimal profile editor (Electron-parity fields) |
| `VpnSetupActivity` | no | Nord dashboard WebView + WireGuard tunnel controls |
| `AutomationService` | no (`dataSync` fg service) | Keeps process alive backgrounded/screen-off; persistent status notification; 12h `PARTIAL_WAKE_LOCK` |
| `A11yService` | yes (bound by system, `BIND_ACCESSIBILITY_SERVICE`) | `dispatchGesture` genuine-input taps for the cross-origin Turnstile iframe |
| `GoBackend$VpnService` (wireguard lib) | no (`BIND_VPN_SERVICE`) | The actual `tun0` interface owner |

Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

## Driver abstraction

`Engine` never touches Android UI directly — it drives the page through the `Driver` interface (`Engine.kt` top), implemented by `MainActivity`:

```kotlin
interface Driver {
    suspend fun eval(js: String): String        // evaluateJavascript → unwrapped string
    suspend fun tap(cssX: Double, cssY: Double) // CSS coords → screen coords → gesture
    suspend fun reload()
    suspend fun clearCache()                    // WebView disk cache — cookies preserved (CookieManager)
    fun beep()                                  // audible alert — desktop playBeep parity
    fun log(msg: String)                        // on-screen log pane + Logcat "IVAC"
    fun client(emoji: String, msg: String)      // prominent status line in log
    fun notifyEvent(title: String, msg: String) // Android notification ONLY — never Telegram
    fun setStatus(status: String)               // status chip + fg-service notification
    fun isStopped(): Boolean
    fun lastMainFrameHttpError(): Int
}
```

Net interception does **not** flow through `Driver` — `IvacBridge.net()` calls `Engine.onNetEvent` directly.

Because the UI is the driver, the same `Engine` could run against a test double — the seam for future unit tests.

## JS bridge

- `webView.addJavascriptInterface(IvacBridge(), "IVAC")` gives injected JS two sinks: `IVAC.log(str)` → log pane, `IVAC.net(json)` → `Engine.onNetEvent`.
- `Js.INIT` is re-injected on `onPageStarted` **and** `onPageFinished`: it wraps `fetch` + `XMLHttpRequest` so every XHR response is mirrored to `IVAC.net({u,s,req,res})`.
- `Engine.onNetEvent` filters for `schedule-group` / `custom-actions` traffic, logs `[api] route → status`, pushes `get-family-ofc-schedule-days` / `…-entries` JSON into conflated `Channel`s, and counts 403/429 strikes for rotation.

## Engine state machine

`runLoop()` evaluates `Js.STATE` each cycle → `PageInfo.fromJson` → `PageInfo.state` maps DOM signals to:

```mermaid
stateDiagram-v2
    [*] --> detect
    detect --> VERIFICATION: cf widget/verify text
    detect --> QUEUE: virtual-queue text
    detect --> HARD_BLOCKED: blockReason ≠ ""
    detect --> RATE_LIMITED: CF-1015 / rate-limit text
    detect --> ERROR_PAGE: 5xx/conn-error page
    detect --> LOGIN: login form
    detect --> SECURITY_Q: secq fields
    detect --> PRIVACY: privacy act
    detect --> HOME: schedule link / Home title
    detect --> OFC: /ofc-schedule URL
    detect --> CONSULAR: /schedule URL
    detect --> UNKNOWN: else
    VERIFICATION --> detect: solver v2 (grace → revolving taps)
    QUEUE --> detect: wait 15s — NEVER reload
    HARD_BLOCKED --> detect: staged recoverFromBlock
    RATE_LIMITED --> detect: backoff 45→120s; rotate on ×3
    ERROR_PAGE --> detect: backoff reload (≤5 → pause)
    LOGIN --> detect: fill+submit (loginFailed → pause)
    SECURITY_Q --> detect: answer by question match
    PRIVACY --> detect: accept
    HOME --> detect: NAV_SCHEDULE
    OFC --> detect: ofcLoop city cycle
    CONSULAR --> detect: ofcLoop city cycle (VAC-stripped)
    UNKNOWN --> detect: wait; reload after 30 rounds
    OFC --> CONSULAR: booked → continue (not stop)
    CONSULAR --> [*]: consular booked
```

Priority order inside `PageInfo.state`: verify → queue → rateLimited → blockReason → errorPage → privacy → secQ → login → OFC/consular → home → unknown.

`STATE` classification mirrors desktop `isHardBlocked`: CF selectors (`#cf-error-details`, `#cf-wrapper`, `.cf-subheadline` containing the domain) → `cloudflare_blocked`; title/body regexes → `access_limitation` / `cloudflare_blocked` / `rate_limited`. Additional signals: `queue` (virtual-queue texts — never reloaded), `cfSolved` (`cf-turnstile-response`/`cf_challenge_response` token populated — definitive solve verdict), `loginFailed` (`ExternalAuthenticationFailed` URL or sign-in-failed text → pause instead of blind retries).

### OFC/consular loop detail (`ofcLoop()`)

1. Strike-1/2 recovery: `homeRecoveryPending` → jittered 3–5s pause → navigate home → `NAV_SCHEDULE` re-entry (desktop parity — a stale CF session resets via home↔schedule before strike 3 burns an IP).
2. `Js.city(name)` selects the VAC city — consular stage strips the ` VAC` suffix (`NEW DELHI VAC` → `NEW DELHI`, desktop `consular-schedule.ts` parity). Single-city profiles pass `withEmptyPreselect`.
3. `waitSchedDays(respWaitMs())` — API `ScheduleDays` is authoritative; DOM calendar is UNIONed in so a stale API payload can't hide visible green dates.
4. `extractApiDates()` normalizes `ScheduleDate|Date|CalendarDate|Day|SlotDate` → `YYYY-MM-DD`; `inRangeList()` filters `startDate..endDate` (lexicographic).
5. On any calendar visibility: `SlotLog.record()` (`stage="ofc"`/`"consular"`) + notification + `beep()` (dual-tone, desktop `playBeep` parity).
6. Per in-range date (cap `MAX_DATE_ATTEMPTS=3` per city): `calMonthYear` → re-read DOM cal → `dateClick` (one retry) → entries wait → `PRE_SUBMIT` → `pickTime`/`fireSubmit` → `SUBMIT_RESULT` + authoritative `appointments-for-family` API verdict.
7. Disguised-block guard: when both API and calendar come back empty, the page is re-fingerprinted for `blockReason` before advancing city.
8. Outcomes: OFC `booked` → `Telegram.sendOfcBooked` + beep + `Checkpoint.save("ofc-booked")` → **returns to runLoop which continues into the consular stage**; consular `booked` → `Telegram.sendConsularBooked` + stop; `taken` → next date; `left` → outer loop resumes.
9. Next city after `profile.cityRetrySeconds` (special-window alignment unchanged).

After OFC success the engine waits for the site redirect to `/en-US/schedule/` (up to 2min — never re-runs the OFC cycle, avoiding double-book). The first CONSULAR detection per run fires `Telegram.sendConsularStage` once, then the same DOM cycle books consular slots. A direct-API booking navigates the page to the consular URL itself (a raw XHR submit never triggers the site redirect).

`dryRun=true` never clicks the final submit (JS still performs date/time selection).

## Cloudflare solving (solver v2)

`solveCloudflare()` — rebuilt on USAVISABOTV3 (`usavisa/turnstile.py`) findings:

1. **Auto-resolve grace (~8s)** — many challenges self-clear; no tap is attempted during the grace window. Polled every 2s via `cfSolved`/`verify`.
2. **Revolving tap loop (~90s)** — while the challenge is live, `Js.CF_BOX` is re-evaluated each poll and the *current* widget coords are tapped every ~1.5–2s. The widget re-renders/revolves mid-solve ("Cannot find Widget cf-chl-widget-*" console churn); per-poll re-detection survives that.
3. **Pass verdicts** — `cf-turnstile-response`/`cf_challenge_response` token populated (definitive), `cfWaiting` text (solved, origin answering — outer loop waits), or verify markers absent >4s (debounced against re-render gaps).

`Js.CF_BOX` finds the Turnstile host — `#cf-turnstile`, `iframe[src*="cloudflare.com"]`, or the sized ancestor of the hidden `cf-chl-widget-*` input — `scrollIntoView`s it, and returns its `getBoundingClientRect()`. The tap lands at `x + 0.08·w, y + h/2` (the checkbox square).

Tap transport (`MainActivity.tap()`): CSS coords → physical px — `physical = (css − visualViewport.offset) × (devicePixelRatio × visualViewport.scale)` (verified on-device) — then `A11yService.tapAt()` dispatches a **curved `dispatchGesture` stroke** (~120–180ms, shallow arc with micro-overshoot — a single-point teleport reads as synthetic to Turnstile's interaction scoring). Genuine input reaches the cross-origin iframe; falls back to synthetic `dispatchTouchEvent` when the accessibility service is unbound.

Escalation: 2 failed rounds → "CAPTCHA needs you" notification (deduped 5min, **full-screen intent** brings the app forward); every 5th failed round → VPN rotate + reload.

## VPN — embedded WireGuard (NordLynx)

Fully self-contained; no external VPN app.

```mermaid
flowchart LR
    subgraph Provision["VpnSetupActivity + NordProvisioner"]
        W1["WebView → my.nordaccount.com<br/>(user logs in once)"]
        TK["GET KEY:<br/>JS_TOKEN_CLICK → JS_TOKEN_GENERATE<br/>→ JS_TOKEN_GRAB"]
        KEY["jsFetchKey:<br/>GET /v1/users/services/credentials<br/>Basic base64(token:<TOKEN>)"]
        SV["SERVERS:<br/>/v1/servers/recommendations<br/>fallback /v1/servers"]
        W1 --> TK --> KEY
        SV --> POOL["wg_servers JSON<br/>(≤4/country, ordered)"]
        KEY --> STORE[("Store (AES-GCM)<br/>wg_privkey, nord_token")]
        POOL --> STORE
    end
    subgraph Tunnel["VpnManager"]
        ROT["rotate(): cooldown 2min →<br/>NEXT server in ordered pool →<br/>connect → verify api.ipify.org"]
        CON["connect(): Config.Builder<br/>iface 10.5.0.2/32 + DNS 103.86.96.100<br/>peer pubkey + host:51820<br/>allowedIPs 0.0.0.0/0 keepalive 25"]
        ROT --> CON
    end
    STORE --> Tunnel
    Engine -->|"block stage-2 / 403-429 ×3<br/>/ silent-block ×3"| ROT
```

**Ordered rotation** (desktop `CITY_ROTATION_SEQUENCE` parity at country granularity): the pool is fetched in `NordProvisioner.TARGET_COUNTRIES` order — **US → UK → France → Denmark → Czech Republic → Papua New Guinea → Costa Rica** first (the desktop sequence), then broad-fleet countries (Canada, Netherlands, Germany, Switzerland, Sweden, Spain, Italy, Japan, Singapore, Australia, UAE, Hong Kong) as tail depth; India is excluded (virtual-India servers share one NAT egress). `VpnManager.rotate` walks the ordered pool via a per-process `rotationIndex` that wraps — every process starts at the first US server, like the desktop's in-memory city index. Same-exit-IP retries advance to the next *different-country* entry (≤3 tries per rotation).

**Triggers** (in `Engine`, desktop `recoverFromBlockPage` + strike semantics):
- `HARD_BLOCKED` page → `recoverFromBlock(blockReason)`: `access_limitation` → `clearCache()` + rotate + reload; `cloudflare_blocked` (CF-1020) → **two-stage**: wait 30s → navigate home → re-check; only if still blocked → `clearCache()` + rotate; `rate_limited` → 60s backoff + reload, never rotates.
- Schedule-API `403/429` → strikes 1–2 set `homeRecoveryPending` (ofcLoop re-enters via home page, jittered 3–5s pause); **strike 3 → rotate** (suppressed inside drop windows via `suppressApiRotateUntil`).
- Silent-block: ×3 consecutive schedule-API timeouts with zero completed responses → rotate (egress tarpitted, no 403 arrives to strike on).
- Tunnel watchdog: tunnel dropped mid-run → `rotate()` reconnects the same server inside cooldown.

Guards: `rotating` in-flight flag, `!paused`, `!domFallbackActive` (DOM cycle shields strikes), 2-min `lastRotateAt` cooldown (stamped on success only), strike reset on 2xx and post-rotation. VPN not configured → notify + pause (human rotates via VPN screen).

**Consent:** first tunnel-up needs the Android VpnService consent dialog (`VpnManager.prepareIntent`); `rotate()` refuses silently while consent is missing.

## Persistence — `Store`

- AES-256-GCM key generated once in AndroidKeyStore (alias `ivac_profiles_key`, never leaves TEE); ciphertext in SharedPreferences. Blob = Base64(12B IV + CT).
- `profiles_v2` — encrypted `Profile[]` JSON (one-time migrates legacy plaintext `profiles` key).
- `set_<key>` — encrypted settings: `wg_privkey`, `nord_token`, `wg_servers`, `vpn_ip`, `tg_token`, `tg_chat`, `running_profile`, `a11y_asked`, `battery_asked`, `direct_api`.
- `importDesktopConfig(json)` — parses desktop `config.local.json`, **merges by id/username** preserving `dryRun`/`enabled`/`cityRetrySeconds`.
- `profiles_import.json` bootstrap — `MainActivity.onCreate` imports `filesDir/profiles_import.json` if present, then deletes it (how `adb push`/`run-as` seeding works).

## Notifications & services

- `AutomationService` — foreground notification ("IVAC running" + live status via `updateStatus`) with **Pause/Resume/Stop action buttons** (app-internal broadcasts to `MainActivity`'s non-exported receiver); 12h partial wake lock; `START_STICKY`.
- Event notifications — channel `ivac_events` (HIGH): CAPTCHA-needed, calendar-open, booked, IP-blocked, error loops. CAPTCHA-needed carries a **full-screen intent** (`USE_FULL_SCREEN_INTENT`) that brings the app forward for the manual tap. **These are Android-local only — `notifyEvent` no longer mirrors to Telegram.**
- `Telegram` — hardcoded desktop bot token/channel as defaults; `configure(store)` applies SET-dialog overrides (`tg_token`, `tg_chat`). **Telegram fires on exactly 3 events**: `sendOfcBooked` (confirmed `appointments-for-family` 2xx / booked outcome), `sendConsularStage` (first consular-page detection per run), `sendConsularBooked`. Nothing else ever reaches the channel.
- `SlotLog` — `filesDir/slot-observations.jsonl`, schema mirrors desktop `slot-tracker.ts` (`timestamp/profile/stage/city/availableDates/inRangeDates`).
- `Checkpoint` — `filesDir/checkpoint.json`, last detected state + city + URL per loop iteration (desktop `checkpoint.ts` parity — forensic post-mortem; the engine re-derives state from the live page on resume, no fast-resume needed).

## Lifecycle & resilience

- `singleTask` + all `configChanges` → rotation/keyboard never recreate the Activity.
- `running_profile` setting → auto-resume engine after process/Activity recreation.
- `CookieManager.flush()` every 60s + `onPause` → session cookies survive restarts.
- `onRenderProcessGone` → reload; main-frame HTTP errors tracked for block detection.
- `SCRN` toggles `FLAG_KEEP_SCREEN_ON`; `REFRESH` → `webView.reload()`; `FULL` hides chrome for a fullscreen WebView (BACK exits); hardware BACK → `webView.goBack()` when history exists, `moveTaskToBack` mid-run (never kills the engine).
- Battery: one-time prompt → `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- Accessibility: one-time prompt → `ACTION_ACCESSIBILITY_SETTINGS` (needed only for auto CF taps).

## Profile editor (Electron parity)

`ProfileActivity`: Username, Password, 3 × (question dropdown + answer field) using the Electron `questionGroups` (stored questions not in a group appear as a custom option so pairings survive), 5 VAC city checkboxes, Start/End Date, Preferred Time, Retry Seconds, Dry-run + Prefer-least-busy-slot checkboxes, Save/Delete.

## Direct schedule-API path

Gated by the `direct_api` setting (header API:ON/OFF button, default OFF). When ON and on the OFC page, `directSweep` polls every configured city via same-origin `custom-actions` POSTs (`Js.DIRECT_*`) — no DOM city-select needed — and books via the entries→submit token chain with a fresh Token per attempt. `preferLeastSlots` flips the entry ordering (least- vs most-availability first). Three consecutive sweep errors fall back to the DOM cycle for that pass. Consular always uses the DOM cycle (direct sweep is OFC-only). Booking chain is still awaiting a live-drop verification — DOM fallback keeps failure modes safe.

## Known deltas vs desktop

- Direct API is the fetch-based sweep above — not the desktop's 3-tier jQuery/XHR/DOM-capture stack (`api-direct.ts` Tier-1/2 don't exist on mobile).
- Rotation pool is country-granular (≤4 WG servers/country) vs the desktop's 67-city NordVPN CLI sequence — same order, coarser granularity.
- `Checkpoint` is forensic-only (no fast-resume — page state is re-derived live); no Playwright-style diagnostics/traces.
- One profile runs at a time (selection UI; concurrent sessions are a future goal).
