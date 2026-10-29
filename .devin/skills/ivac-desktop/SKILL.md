---
name: ivac-desktop
description: Build, run, and release the IVAC desktop launcher — npm scripts, Electron UI, release pipeline, known build issues
---

# IVAC Desktop — Build & Release Workflow

TypeScript core (`src/`) + Electron launcher (`ui/`). See `docs/desktop.md` for the module map.

## Commands

```bash
npm install
npm run prepare          # patchright install chromium (required once)
npm start                # headless core: tsx src/index.ts
npm run ui:start         # Electron launcher — spawns one core per started profile
npm run build            # tsc → dist/ (use this to typecheck)
npm run protect          # esbuild bundle+minify → protected/app.js
npm run build:core       # @yao-pkg/pkg → dist/ivac-core.exe
npm run build:release    # scripts/build-release.mjs → release<N>/win-unpacked/ + zip
npm run build:dev        # release with --mode=dev
npm run build:client     # release with --mode=client
```

## Runtime model

- `ui/main.js` spawns `node_modules/.bin/tsx.cmd src/index.ts` per profile in dev (`ivac-core.exe` when packaged). `dist/` is not needed for dev runs.
- Per-profile isolation: `chromeUserDataDir` + `chromeRemoteDebugPort` + flag files `.ivac-stop-<id>`/`.ivac-start-<id>` + checkpoint under `artifacts/`. **Stop = pause+listen, not kill** — the core enters `pauseAndListen` (zero page actions; watches URL transitions + submit responses → reports `ofc_submitted`/`consular_submitted` to Supabase) and resumes on the Start flag. `checkStopSignal()` sets the persistent `stopRequested` global on consume so deep sites can't swallow the stop. Hard kill only via `stopAllProfiles` (launcher quit) or dead browser.
- `config.local.json` is the live config (gitignored); `config.example.json` is the template. Some profiles' `chromeUserDataDir` point inside `release*/win-unpacked/` — do not delete those release dirs.
- NordVPN rotation is machine-wide via `nordvpn.exe` (`src/nordvpn.ts`) — requires NordVPN desktop app running + kill switch OFF. One IP shared by all profiles.
- Rotation walks `CITY_ROTATION_SEQUENCE` (`nordvpn -c -g "<city>"` — city names are valid `-g` groups on this build, verified on-device): US 55 cities → UK 4 → France 4 → Denmark → Czech Republic → Papua New Guinea → Costa Rica/San Jose, then wraps. The positional `-c <country> <city>` form is silently ignored → quick-connects to fastest/India; do NOT use it. In-memory per-process index; max 5 cities per rotation, then a `-c -g <country>` fallback for the last-attempted country (never bare Quick Connect). Every new IP is **geo-verified via ip-api.com** — a wrong-country exit is rejected. `nordvpn.exe` prints no stdout for `cities`/`countries`/`status` on this build — city lists came from `api.nordvpn.com/v1/servers/countries`; verify connects via public IP + geo, not CLI output.
- Hard-block recovery (`recoverFromBlockPage` in `src/index.ts`) is staged: Access limitation → cache clear + rotate + reload; "You are blocked" → 30s + home retry, rotate only if still blocked; CF 1015 → backoff. Schedule-API 403/429 checks `isHardBlocked` before soft-strike recovery; timeouts wait 2-3 min (not blocks).
- Special windows (`SPECIAL_WINDOW_TRIGGERS_SEC`): second :58 of minutes 12, 25, 29, 36, 49, 55, 59 each hour on the **local system clock**. The retry delay is shortened to fire a selection exactly at :58 when a trigger falls inside it; with multiple cities configured that selection also arms a sweep — all cities tried once at 2-4s gaps, 60s response cap, abort on timeout. The `SPECIAL WINDOW` log prefix is a known marker, don't rename it.

## Known build issues (expected, don't chase)

- `winCodeSign` Darwin-symlink error during electron-builder — tolerated; unpacked app + zip still produce. Other build failures are real.
- `eval('require')` warning in `src/browser.ts` — required for pkg runtime resolution; do not "fix" it.
- Never obfuscate `ui/` files — breaks Electron event handlers.

## Conventions

- Behavior preservation matters: users run this in production. Prefer additive changes over edits to the live loop in `src/index.ts`.
- `[TEMP LOG]` markers in `src/api-direct.ts` were removed — keep it that way; use the normal logger.
- Telegram token/channel are hardcoded in `src/telegram.ts` — never echo them into logs or docs.
- License code (`license.ts`, `supabase.ts`, `scripts/gen-license.mjs`, `fix-rls.mjs`) is ops tooling — keep unless asked.
