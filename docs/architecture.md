# System Architecture — IVAC

Two independent automation clients target `usvisascheduling.com` (OFC appointment booking):

| Client | Runtime | Location | Status |
|---|---|---|---|
| **Desktop launcher** | Electron UI + Node core (TypeScript, Patchright/CDP) driving a real Chrome | `src/`, `ui/` | Production |
| **Android app** | Kotlin app with an embedded WebView + in-app automation engine | `mobile_session/app/` | Active development |

Both share the same booking semantics: Cloudflare handling → login → security questions → Privacy Act → home → OFC schedule → city rotation → date/time selection → submit → Telegram notification. Mobile is a deliberate port of the desktop state machine.

---

## System context

```mermaid
flowchart LR
    subgraph Desktop["Desktop (Windows)"]
        UI["Electron UI<br/>ui/main.js + renderer.js"]
        CORE["ivac-core<br/>src/index.ts loop"]
        CHROME["Real Chrome<br/>(CDP via Patchright)"]
        NORDCLI["NordVPN CLI<br/>src/nordvpn.ts"]
        UI -->|spawn/status API| CORE
        CORE -->|connectOverCDP| CHROME
        CORE -->|rotate on block| NORDCLI
    end

    subgraph Android["Android (standalone APK)"]
        ACT["MainActivity<br/>WebView + log UI"]
        ENG["Engine<br/>state machine"]
        JS["JsSnippets<br/>injected JS"]
        WG["VpnManager<br/>embedded WireGuard"]
        ACT -->|Driver iface| ENG
        ENG -->|evaluateJavascript| JS
        ENG -->|rotate on block| WG
    end

    SITE["usvisascheduling.com"]
    TG["Telegram channel<br/>(bot API)"]
    NORDAPI["api.nordvpn.com<br/>+ my.nordaccount.com"]
    SB["Supabase<br/>(license + telemetry)"]

    CHROME --> SITE
    ACT --> SITE
    CORE --> TG
    ENG --> TG
    WG --> NORDAPI
    UI --> SB
    CORE --> SB
```

---

## Booking pipeline (both clients)

```mermaid
sequenceDiagram
    participant E as Engine loop
    participant W as WebView / Chrome
    participant S as usvisascheduling.com
    participant V as VpnManager / NordVPN
    participant T as Telegram

    loop until booked or stopped
        E->>W: eval(STATE) — page fingerprint
        alt Cloudflare verification
            E->>W: CF_BOX → locate widget → tap()
            W-->>S: challenge response
        else Login page
            E->>W: fill credentials, submit
        else Security questions
            E->>W: match question text → fill answers
        else Privacy Act
            E->>W: click accept
        else Home
            E->>W: navigate to OFC schedule
        else OFC schedule
            loop per configured city
                E->>W: select city in dropdown
                W-->>S: POST get-family-ofc-schedule-days
                S-->>E: intercepted response (ScheduleDays)
                E->>E: extract dates → filter startDate..endDate
                alt in-range date exists
                    E->>W: calMonthYear(m,y) → dateClick(iso)
                    W-->>S: get-family-ofc-schedule-entries
                    S-->>E: intercepted response (ScheduleEntries)
                    E->>W: timeAndSubmit(preferredTime)
                    E->>W: SUBMIT_RESULT → booked/taken/left/unknown
                    E->>T: sendOfcBooked (fire-and-forget)
                else no dates
                    E->>E: next city after cityRetrySeconds
                end
            end
        end
    end
```

### Key semantic: API-first

`ScheduleDays` from the intercepted `get-family-ofc-schedule-days` response is the **authoritative** availability source — each entry IS an open day. The rendered DOM calendar is only a fallback when the API response never arrives. Dates are normalized to `YYYY-MM-DD` and compared lexicographically against `appointment.startDate..endDate`.

---

## Block-triggered VPN rotation

Rotation is event-driven only — there is no periodic timer. Identical semantics on both platforms.

```mermaid
flowchart TD
    A[Schedule API response] --> B{status?}
    B -->|200-299| C[strike counter = 0]
    B -->|403/429| D[apiStrikeCount++]
    D -->|strikes 1-2| D2[homeRecoveryPending →<br/>home↔schedule re-entry]
    D -->|strike >= 3<br/>AND not in window| E{VPN configured?}
    E -->|yes| F[rotating=true<br/>VpnManager.rotate]
    F --> G{new public IP?}
    G -->|yes| H[strikes=0 → reload page]
    G -->|no| I[pause engine + notify]
    E -->|no| J[notify 'IP likely blocked'<br/>pause]
    K[Hard block page /<br/>main-frame 403/429] --> F
    F -.->|2-min cooldown<br/>shared lastRotateAt| F
```

Desktop rotation: `src/nordvpn.ts` runs `nordvpn -d` then `nordvpn -c -g <city>` walking an **ordered city sequence** (US 55 cities → UK 4 → France 4 → Denmark → Czech Republic → Papua New Guinea → Costa Rica/San Jose, wraps; per-process index, max 5 cities per rotation). Every new IP is **geo-verified via ip-api.com** — a wrong-country exit is rejected and the walk continues; final fallback is `nordvpn -c -g <country>` for the last-attempted country (never bare Quick Connect, which lands on the fastest server). Machine-wide, all profiles share the IP, guarded by a file lock + cooldown file. Android mirrors this at **country granularity**: `VpnManager.rotate` walks the WG pool in the same country order (US → UK → FR → DK → CZ → PNG → CR, then broad-pool countries) via a per-process `rotationIndex`, and advances to a different country when the exit IP is unchanged.

Block staging is identical on both platforms (`isHardBlocked`/`blockReason` classification): **Access limitation** → cache clear (cookies preserved — `clearCache()` leaves CookieManager alone) + rotate + reload; **CF-1020 "You are blocked"** → wait 30s + navigate home first, rotate only if still blocked; **CF-1015 rate-limited** → backoff, no rotation. Schedule-API 403/429: strikes 1–2 recover via a home↔schedule re-entry (`homeRecoveryPending`), strike 3 rotates — suppressed inside special windows. A navigation timeout during recovery waits — never counted as a block.

---

## Cloudflare / Turnstile handling

```mermaid
flowchart TD
    S[STATE eval reports verify=true] --> G0["grace ~8s<br/>(poll cfSolved/verify — auto-resolve)"]
    G0 --> B{STATE poll ~2s}
    B -->|cfSolved token| W[✅ continue loop]
    B -->|verify absent >4s| W
    B -->|cfWaiting text| W0[return — outer loop waits for origin]
    B -->|verify still true| B2[eval CF_BOX → tap current coords]
    B2 --> B
    B -->|90s deadline| I[cfFailRounds++]
    I -->|2 rounds| J[notifyEvent 'CAPTCHA needs you'<br/>full-screen intent]
    I -->|5 rounds| K[rotate VPN + reload]
```

**Android tap path:** `Engine.solveCloudflare()` → `Driver.tap(cssX, cssY)` → `MainActivity.tap()` converts layout-viewport CSS coords → physical px (`(css − visualViewport.offset) × (dpr × vvScale)`) → `A11yService.tapAt()` dispatches a **curved `dispatchGesture` stroke** (~150ms arc + overshoot — genuine input reaching the cross-origin Turnstile iframe); falls back to synthetic `dispatchTouchEvent` when the accessibility service isn't enabled.

**Desktop tap path:** `src/cloudflare.ts` uses 4 strategies including Bezier-curve mouse movement; falls back to waiting for a human.

---

## Android component map

```mermaid
flowchart TD
    subgraph App["com.ivac.mobile"]
        MA["MainActivity<br/>(exported, singleTask)<br/>WebView + Driver impl + profile UI"]
        PA["ProfileActivity<br/>profile editor"]
        VS["VpnSetupActivity<br/>Nord dashboard WebView + tunnel controls"]
        AS["AutomationService<br/>foreground svc + wake lock"]
        AX["A11yService<br/>accessibility gesture injection"]
        EN["Engine<br/>booking state machine"]
        VP["VpnManager<br/>GoBackend WireGuard tunnel"]
        NP["NordProvisioner<br/>token→key fetch + server pool"]
        ST["Store<br/>AndroidKeyStore AES-GCM prefs"]
        TL["Telegram<br/>bot API"]
        SL["SlotLog<br/>JSONL observations"]
        SN["JsSnippets<br/>JS constants"]

        MA --> EN
        MA --> AS
        MA --> ST
        MA --> AX
        EN --> SN
        EN --> VP
        EN --> TL
        EN --> SL
        VS --> NP
        VS --> VP
        NP --> ST
        VP --> ST
    end
    WG["com.wireguard.android<br/>GoBackend$VpnService"]
    VP --> WG
```

| File | Role |
|---|---|
| `MainActivity.kt` | WebView host, `Driver` implementation, profile list UI, engine lifecycle, auto-resume after recreation, `profiles_import.json` bootstrap, header controls (API/REFRESH/FULL/SCRN/SET/VPN/STOP), JS-dialog auto-dismiss, service-action receiver |
| `Engine.kt` | `runLoop()` state machine + `ofcLoop()` city rotation (OFC + consular stages); staged `recoverFromBlock`, 3-strike API rotation w/ home re-entry, queue/login-fail states, checkpoint writes, direct-API sweep |
| `JsSnippets.kt` | All injected JS: `INIT` (fetch/XHR interception), `STATE` (page fingerprint + `blockReason`/`queue`/`cfSolved`/`loginFailed`), `PRIVACY`, `NAV_SCHEDULE`, `CAL_READ`, `PRE_SUBMIT`, `SUBMIT_RESULT`, `CF_BOX`, `DIRECT_*` + builders `login/secq/city/calMonthYear/dateClick/timeAndSubmit` |
| `Models.kt` | `Profile`/`Appointment`/`SecurityQ` (mirrors `config.local.json`, + `preferLeastSlots`), `PageState`/`PageInfo` fingerprint |
| `VpnManager.kt` | WireGuard `Config` build, tunnel up/down, public-IP verify, `rotate()` — 2-min cooldown + ordered `rotationIndex` walk over country-sorted pool |
| `NordProvisioner.kt` | Nord dashboard JS (token generation, page scrape), `api.nordvpn.com` credentials fetch (Basic `token:<TOKEN>`), `TARGET_COUNTRIES`-ordered WG server pool fetch+parse+cache |
| `VpnSetupActivity.kt` | Nord login WebView, GET KEY / SERVERS / CONNECT / ROTATE / DISC / PASTE / SCRAPE controls |
| `ProfileActivity.kt` | Minimal editor: credentials, 3× security-Q dropdowns (Electron question groups) + answers, VAC city checkboxes, dates, preferred time, retry seconds, dry run, prefer-least-busy |
| `Store.kt` | AES-256-GCM in AndroidKeyStore; `profiles_v2` + `set_*` keys; `importDesktopConfig` merge preserving `dryRun`/`enabled`/`cityRetrySeconds` |
| `AutomationService.kt` | `dataSync` foreground service, persistent notification w/ live status + Pause/Resume/Stop actions, 12h partial wake lock |
| `A11yService.kt` | Curved-stroke `dispatchGesture` taps at absolute screen coords (for cross-origin iframes) |
| `Checkpoint.kt` | `checkpoint.json` in `filesDir`, last state/city/URL per loop tick (port of `src/checkpoint.ts`) |
| `SlotLog.kt` | `slot-observations.jsonl` in `filesDir`, one JSON per calendar-visibility event |
| `Telegram.kt` | Success-only: `sendOfcBooked`/`sendConsularStage`/`sendConsularBooked`, hardcoded defaults overridable via SET dialog |

## Desktop component map

See `ARCHITECTURE.md` (root) and `docs/desktop.md` for the full `src/*.ts` module table. In short: `ui/main.js` (Electron main) spawns `src/index.ts` via `tsx` in dev (or `ivac-core.exe` packaged), which runs the same detect→act loop against a real Chrome over CDP, with `api-direct.ts` providing the 3-tier fast submission path the mobile port does not yet have.
