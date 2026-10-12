---
name: ivac-mobile-debug
description: Live-debug the IVAC Android engine on-device — logcat signatures, checkpoint.json/slot-observations pulls, engine state probing, VPN/Turnstile verification, known failure patterns
---

# IVAC Mobile — On-Device Debugging

Companion to `ivac-mobile` (build/install). This skill covers diagnosing the *running* engine. `adb` is `D:/platform-tools/adb.exe`; test device `R3CW90ADGLH`.

## Logcat — the primary window

```bash
D:/platform-tools/adb.exe logcat -s IVAC:* IVAC-VPN:* IVAC-NORD:*   # app only
D:/platform-tools/adb.exe logcat -d -s IVAC:* | tail -100          # dump recent
```

Everything the engine logs goes to tag `IVAC` (the log pane and Logcat are the same stream). `IVAC-VPN` = WireGuard lifecycle, `IVAC-NORD` = pool provisioning.

## State signatures — what healthy looks like

| Log line | Meaning |
|---|---|
| `STATE → LOGIN` | login page detected |
| `CF passed — waiting for site to respond` | `cfWaiting`: Turnstile token issued, origin still answering — NORMAL, waits up to 7min |
| `Origin hung 1min after CF pass — reloading` | patience bound hit, single reload (no rotation) |
| `QUEUE — waiting in line` | virtual waiting room — never navigates away |
| `Recovering block page (cloudflare_blocked) — waiting 30s` | CF-1020 stage 1: home re-check before rotation |
| `API strike 3 — rotating IP` | schedule-API 403/429 threshold (strikes 1–2 = silent home re-entry) |
| `Silent block — 3 timeouts, rotating` | egress tarpitted, no 403 ever arrives |
| `Tunnel dropped — reconnecting` | watchdog: Nord endpoint died mid-run |
| `Checking <city> …` / `→ no dates` | normal ofcLoop cycle |

Red flags: `API strike` messages faster than ~20s apart (strike-storm regression), rotations more than once per 2min (cooldown regression — check `lastRotateAt`), `CF_BOX not found` repeating past the grace window.

## Forensic files (debug builds — `run-as` works)

```bash
# last known state before a crash/kill — written every loop iteration
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell \
  "run-as com.ivac.mobile cat files/checkpoint.json"

# every calendar-visibility event (JSONL, same schema as desktop slot-tracker)
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell \
  "run-as com.ivac.mobile cat files/slot-observations.jsonl"

# pull for offline analysis
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell \
  "run-as com.ivac.mobile tar -cf - files/checkpoint.json files/slot-observations.jsonl" > ivac-files.tar
```

`checkpoint.json` is forensic-only — the engine re-derives state from the live page on resume; it exists to answer "what was it doing when it died".

## Probing the engine

```bash
# Is the engine running? (foreground service)
D:/platform-tools/adb.exe shell dumpsys activity services com.ivac.mobile | grep Automation

# Is the WebView on a CF page right now? check current URL in dumpsys window focus
D:/platform-tools/adb.exe shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'

# VPN tunnel interface up?
D:/platform-tools/adb.exe shell "ip addr show tun0 2>/dev/null || ip addr | grep -A2 tun"

# Accessibility service bound? (genuine taps depend on this)
D:/platform-tools/adb.exe shell settings get secure enabled_accessibility_services
```

## Known failure patterns

- **CF solved but 403 persists**: `cf_clearance` issued AND sent but origin replies `cf-mitigated: challenge` + new challenge = **site-side perma-challenge — real Chrome on the same device+IP behaves identically** (verified 2026-10). `post-pass-reject` fires rotation after 3 rapid re-challenges. NOT a solver bug — do not chase it.
- **ENGINE STOPPED / app backgrounded**: `AutomationService` notification must exist; if the process died, check `checkpoint.json` for the last state and whether `running_profile` triggered auto-resume on relaunch.
- **Taps landing wrong**: `MainActivity.tap` math is `(css − visualViewport.offset) × (webView.width / visualViewport.width)` — self-calibrating, verified on `R3CW90ADGLH` + `RMX1992`. If a new device misses, log the viewport eval string — don't subtract `webView.scrollY`.
- **a11y taps fire but box never ticks**: the gesture stroke must stay within touch-slop (~8px) — a stroke that touches down away from the target and slides to it is dispatched as a drag. `A11yService.tapAt` uses ±2.5px jitter; if regressed to an approach-arc stroke, that IS the bug.
- **Everything hangs, no logs**: a JS `alert()` freezes the page thread — `onJsAlert` auto-dismisses, but check `onJsBeforeUnload`/modal dialogs if evals stall.
- **Rotation picks India/shared-egress**: pool should exclude India (`TARGET_COUNTRIES`). If the stored `wg_servers` pool predates ordering, `ensurePool()` refetches when <5 countries — or re-run SERVERS in the VPN screen.
- **`cannot read property` / eval returns `null`**: page DOM changed — re-dump `STATE` output fields (`blockReason`, `queue`, `cfSolved`, `loginFailed`) and check `JsSnippets.kt` selectors against the live page.

## Simulating conditions

```bash
# kill mid-run → verify checkpoint + auto-resume
D:/platform-tools/adb.exe shell am force-stop com.ivac.mobile
D:/platform-tools/adb.exe shell am start -n com.ivac.mobile/.MainActivity

# airplane-mode toggle → exercises silent-block/timeout path
D:/platform-tools/adb.exe shell svc data disable && sleep 60 && D:/platform-tools/adb.exe shell svc data enable

# notification action broadcast → exercises Pause/Resume/Stop receiver
D:/platform-tools/adb.exe shell am broadcast -a com.ivac.mobile.ACTION_PAUSE -p com.ivac.mobile
```
