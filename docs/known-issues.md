# Known Issues, Open Investigations & Recommendations

Status register for future sessions. Ordered by urgency.

---

## 1. Resolved: Cloudflare Turnstile interactive challenges (Android)

**Resolved root causes (three separate bugs):**
1. `getBoundingClientRect()` returns *layout-viewport* coords — taps were ~300-670px too low. Fix: `physical = (css − visualViewport.offset) × (webView.width / visualViewport.width)` — self-calibrating scale, verified on two different devices.
2. `document.body.textContent` leaks `<script>` bodies — CF's interstitial bundles "verification successful" strings in inline JS → `cfWaiting` false-positive ("CF passed" while checkbox unchecked). Fix: `innerText` only; success verdict = `cf-turnstile-response` token / `cf_clearance` cookie.
3. **A11y gesture was a drag, not a tap** — the curved stroke touched down ~20px away and slid to the target; clicks register at the DOWN point, and >touch-slop (~8px) strokes dispatch as drags. Fix: sub-slop micro-jitter stroke (±2.5px, ~90-160ms) — verified single-tap clears on RMX1992 + SM-S918N.

**Solver v2 (ported from USAVISABOTV3 `usavisa/turnstile.py`):** auto-resolve grace (~8s, no tap while CF may self-clear) → revolving tap loop (~90s) that re-evaluates `CF_BOX` and taps *current* coords every ~1.5–2s — survives widget re-render/revolve ("Cannot find Widget cf-chl-widget-*" console churn) — with three pass verdicts: `cf-turnstile-response` token populated (definitive), `cfWaiting` text (solved, origin answering), or verify markers absent >4s (debounce). Taps are sub-slop `dispatchGesture` strokes (see #1.3 — the old curved-arc stroke was a drag and never ticked the checkbox).

**Fingerprint hygiene on challenge pages:** `Js.INIT` is NOT injected on main-frame-403 pages (CF interstitials are always served 403 — `onReceivedHttpError` knows before the CF markers exist in DOM; marker checks alone race and lose). It also self-skips when `_cf_chl_opt`/challenges markers are present (`cf-skip`) for 200-OK pages embedding Turnstile. Patched `fetch`/`XHR`/`document.hidden` are inspectable by CF's main-frame script and get the session flagged post-clearance. `navigator.webdriver` is intentionally unpatched (WebView never sets it; a JS getter differs from Chrome's native prototype getter). JS bridge renamed `IVAC`→`__cm` — injected interfaces are enumerable inside the cross-origin Turnstile iframe.

**Origin perma-challenge (observed 2026-10, verified NOT an app defect):** after a valid `cf_clearance` is issued AND sent on the next nav (CDP-verified), the origin replies `cf-mitigated: challenge` and serves a fresh challenge. **Real Chrome on the same device + residential IP behaves identically** — the zone is re-challenging all clients right now. Engine escalates via `post-pass-reject` rotation (3 rapid re-challenges → rotate). Nothing else app-side can force acceptance — do NOT chase this as a solver bug.

**Unfixable leaks:** `X-Requested-With: com.ivac.mobile` — `REQUESTED_WITH_HEADER_ALLOW_LIST` is unsupported on tested WebViews (150/153; logged at startup). TLS/JA4 fingerprint differences vs real Chrome cannot be changed from a WebView.

**CF escalation ladder:** every 5th failed round → `VpnManager.rotate` (cooldown-gated) + reload. Manual-tap notification deduped to once/5min + full-screen intent brings the app forward.

**"CF passed, waiting for origin" state:** the solved interstitial lingers while the origin answers (observed 5-9min under load). `STATE.cfWaiting` detects it; engine waits up to **7min** (90s if no live solve seen this session) before a single reload — rotating/reloading here kills in-flight navigations and their cleared sessions.

**JS `alert()` deadlock:** page error handlers call `alert("An error has occurred!")` which freezes the JS thread (every engine `eval` hangs). `WebChromeClient.onJsAlert/Confirm/Prompt` auto-dismiss + log.

**Rejected from USAVISABOTV3:** Whisper audio-captcha fallback — no on-device ASR; audio challenges are rare and the rotate-and-retry ladder covers them.

## 1b. Rate-limit + block handling (Android, desktop parity)

Main-frame 429/CF-1015 pages back off 45s→90s→120s and rotate only on the 3rd consecutive occurrence. Schedule-API 403/429: strikes 1–2 re-enter via the home page (`homeRecoveryPending`), strike 3 rotates (suppressed inside drop windows). Hard-block pages are classified (`blockReason`) and recover staged — `cloudflare_blocked` waits 30s + home re-check before burning a rotation; `access_limitation` clears the WebView cache (cookies preserved) + rotates; `rate_limited` never rotates. `VpnManager.rotate` walks a fixed ordered country sequence (desktop CITY_ROTATION_SEQUENCE parity: US→UK→FR→DK→CZ→PNG→CR then broad pool) and advances to a different country when the exit IP is unchanged — Nord's virtual-India servers share ONE TATA/VSNL NAT egress (`121.243.89.x`), so same-country rotation is useless.

## 2. Open: Security-question field detection gaps (Android)

Log line observed post-login:

```
secq: answered 2 + continue | unknown:Username*;Security Question 1*;Security Question 2*
```

Some form states show unmapped required fields. Verify `Js.secq` field discovery against the current site markup (label association vs placeholder/aria-label), and confirm all three configured Q/A pairs persist and match exactly.

## 3. Verify: Telegram end-to-end (Android)

`Telegram.configure(store)` runs in `MainActivity.onCreate`. Telegram fires on **exactly three** events — `sendOfcBooked` (confirmed booking), `sendConsularStage` (first consular detection per run), `sendConsularBooked`. `notifyEvent` no longer mirrors events to Telegram (CAPTCHA/calendar/IP-block notifications stay Android-local). No real booking has been observed yet — first live booking should confirm channel delivery. Token must never appear in logs — it doesn't currently.

## 4. Verify: full booking pipeline on a real availability event

The complete chain (API days → range filter → calendar nav → dateClick → entries → PRE_SUBMIT → submit → outcome → Telegram) has run step-by-step, but not end-to-end on live availability. The detailed logging added recently exists precisely to debug that event — capture the full log when it happens.

**Direct-API path (mobile, `direct_api` store setting / API:ON-OFF button):** verified live returning real `ScheduleDays` per configured city (~2-3s each, sequential) — same-origin `custom-actions` POSTs, byte-identical to the page's own jQuery calls, no DOM city-select needed. Entries→submit chain implemented (fresh Token per attempt → all slots retriable) but **untested on live availability** — needs a real slot-drop to validate `directBook`. Responses are req-tagged so late stragglers can't cross-attribute cities. DOM cycle remains as fallback after 3 consecutive direct failures. A direct-API booking navigates the page to the consular URL itself (a raw XHR submit never triggers the site's own redirect).

## 5. Security posture (per AGENTS.md + new findings)

- `mobile_session/profiles_import.json` (repo working dir) and `config.local.json` contain **plaintext credentials**. User chose to keep them; mitigate by never committing them (see #6) and considering DPAPI encryption for `config.local.json` per AGENTS.md.
- Telegram bot token + channel ID are hardcoded in `src/telegram.ts` and `Telegram.kt`. If these files ever go public, rotate the bot token.
- `src/supabase.ts` / `ui/main.js` hold a hardcoded Supabase key (AGENTS.md flags replacing with signed JWT).
- `license.ts` REST calls should not need `rejectUnauthorized: false` (verify — flagged in AGENTS.md).

## 6. Git hygiene

- `mobile_session/` (the entire Android app + tools) is **untracked**. One accidental `git clean` loses it.
- `.gitignore` gaps: `chrome-debug-*` (numbered variants), `release12/` `release13/` `release41-*/`, `logs/`, `.ivac-*`, `mobile_session/app/app/build/`, `mobile_session/*.png`, `profiles_import.json`.
- Large uncommitted working tree across `src/` + `ui/` — suggest a checkpoint commit after this cleanup.
- `release12/` + `release13/` disappeared from disk during the cleanup window (2026 session); `config.local.json` still points 3 profiles' `chromeUserDataDir` at `release*/win-unpacked/chrome-debug-*`. Verify they still exist before running desktop profiles, or repoint paths.

## 7. No automated tests

`vitest` is a devDependency but there are zero test files. High-value first tests (pure functions, no browser): `extractApiDates` / `inRangeList` (mobile — port to a JVM test), `loadConfig` validation, desktop `extractDateField`, slot-tracker record shape. `Engine` is testable via the `Driver` seam.

## 8. Android — medium-term concerns

- `A11yService` requires a manual Settings trip and grants broad accessibility capability — document the UX + privacy rationale for end users; reassess whether it's still needed after the CF coordinate fix.
- `VpnSetupActivity` Nord-dashboard scrape depends on Nord's DOM — brittle by nature; prefer API paths (`jsFetchKey` already does).
- Cookie/session persistence relies on `CookieManager.flush()` — verified working, but multi-day expiry behavior unverified.
- Concurrent multi-profile sessions remain a design goal — one `Engine` per WebView would require process/architecture changes (each profile likely needs its own activity instance or a headless WebView per profile).

## 9. Desktop backlog (from AGENTS.md — do not duplicate effort)

Already tracked there: per-profile IP isolation, atomic config writes, per-profile logs, `rejectUnauthorized` removal, license seat binding, consular direct API, auto-updater, human-in-the-loop mode, test suite, CI. See root `AGENTS.md` §1–6.
