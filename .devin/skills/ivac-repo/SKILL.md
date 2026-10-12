---
name: ivac-repo
description: IVAC repository orientation — what lives where, source vs generated, mobile↔desktop parity rules, secrets handling
---

# IVAC Repo Orientation

Two clients, one purpose: automate OFC visa-appointment booking on `usvisascheduling.com`.

```
ivac_ind/
├── src/                    # desktop core (TypeScript) — the reference implementation
├── ui/                     # Electron launcher (main.js + renderer.js + index.html)
├── scripts/                # build-release.mjs, protect.mjs + license ops tooling
├── mobile_session/
│   ├── app/                # Android project (Kotlin; Gradle root)
│   ├── tools/              # vendored JDK17 + Gradle 8.9 + SDK + gradle-home
│   └── profiles_import.json# seed config (plaintext creds — do NOT commit)
├── docs/                   # architecture / desktop / mobile / operations / known-issues
├── .devin/skills/          # ivac-repo, ivac-desktop, ivac-mobile, ivac-mobile-debug
├── AGENTS.md               # product improvement notes + standing rules
├── config.local.json       # LIVE desktop config (gitignored, plaintext creds)
├── release*/               # packaged builds — KEEP (live chromeUserDataDir inside)
├── dist/ protected/        # build intermediates (regenerable)
├── chrome-debug*/          # Chrome user-data dirs (runtime)
└── artifacts/ logs/        # runtime diagnostics
```

## Parity rules

- `src/index.ts` is the reference implementation. Mobile `Engine.kt` ports it — keep semantics aligned: page-state machine, API-first `ScheduleDays`, 403/429 strike → VPN rotate → pause+notify fallback, city rotation, date-range filtering, `dryRun` never submits. Exception: special-window timing is desktop-only by design.
- Hard-block staging is identical on both (`recoverFromBlock`/`recoverFromBlockPage` + `blockReason`): **Access limitation** → cache clear (cookies kept) + rotate + reload; **CF 1020** → 30s wait + home re-check FIRST, rotate only if still blocked; **CF 1015** → backoff only. Schedule-API 403/429: strikes 1–2 recover via home re-entry, strike 3 rotates; nav timeouts wait — never treated as blocks.
- IP rotation is ordered on both platforms: desktop walks `CITY_ROTATION_SEQUENCE` (US 55 → UK → FR → DK → CZ → PNG → CR San Jose); mobile walks the WG pool in `NordProvisioner.TARGET_COUNTRIES` order — same country sequence at coarser granularity (≤4 servers/country), via `VpnManager.rotationIndex`. Both are per-process, both wrap.
- Special windows: `SPECIAL_WINDOW_TRIGGERS_SEC` = second **:58** of minutes 12, 25, 29, 36, 49, 55, 59 every hour on the **local system clock** (not server UTC). A trigger inside the normal retry delay fires an aligned selection at :58; multi-city profiles then sweep all desired cities once (2-4s gaps, 60s cap). Keep the `SPECIAL WINDOW` log terminology unchanged — it's a known log marker.
- Shared question sets: the 3×5 security-question groups live in `ui/renderer.js`; `ProfileActivity.kt` mirrors them.
- Telegram message shape matches `src/telegram.ts` ↔ `Telegram.kt`. **Mobile is success-only** — `notifyEvent` never reaches Telegram; only `sendOfcBooked`/`sendConsularStage`/`sendConsularBooked` do.

## Generated vs source — don't confuse

- `mobile_session/app/app/build/` — Gradle output, delete freely.
- `dist/`, `protected/` — desktop build output, regenerable.
- `release*/` — packaged builds that DOUBLE as runtime homes (Chrome profiles). Ask before deleting.
- `.ivac-*` root files — runtime state, regenerate.
- `mobile_session/profiles_import.json` — consumed by the app on launch (imports then deletes its own copy inside `filesDir`; the repo copy is a seed).

## Secrets discipline

- Plaintext creds exist in `config.local.json` + `profiles_import.json` — never commit, never print into docs/logs.
- Hardcoded secrets in source: Telegram bot token (`src/telegram.ts`, `Telegram.kt`), Supabase key (`ui/main.js`, `src/supabase.ts`), Nord key material lives only in encrypted `Store` — don't add logging that could emit them.
- `.license` file holds the license key — gitignored.

## Before you edit

- Read `AGENTS.md` (product rules: encrypted creds, no `rejectUnauthorized: false`, graceful shutdown, per-profile logs, human-in-the-loop) and `mobile_session/AGENTS.md` for Android parity rules.
- Check `docs/known-issues.md` — open investigations (Turnstile coordinates resolved; live booking verification is the current gap).
- Working style the user expects: preserve the current implementation; copy/port rather than refactor; no changes to live booking behavior unless asked.
