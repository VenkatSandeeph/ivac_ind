---
name: ivac-mobile
description: Build, install, and debug the IVAC Android app (mobile_session/) — vendored toolchain, adb recipes, device-testing patterns
---

# IVAC Mobile — Build & Device Workflow

The Android app lives in `mobile_session/app/` (Gradle root). Source: `app/src/main/java/com/ivac/mobile/` (14 Kotlin files). See `docs/mobile.md` for architecture; `.devin/skills/ivac-mobile-debug` for live-debugging recipes.

## Toolchain — vendored, nothing on PATH

No `gradlew` wrapper; `gradle`/`java` are NOT on PATH. Use the vendored tools:

```bash
cd /d/IVAC/Claude/ivac_ind_v4/ivac_ind/mobile_session/app

JAVA_HOME="D:\\IVAC\\Claude\\ivac_ind_v4\\ivac_ind\\mobile_session\\tools\\jdk\\jdk-17.0.20.1+1" \
GRADLE_USER_HOME="D:\\IVAC\\Claude\\ivac_ind_v4\\ivac_ind\\mobile_session\\tools\\gradle-home" \
/d/IVAC/Claude/ivac_ind_v4/ivac_ind/mobile_session/tools/gradle/gradle-8.9/bin/gradle \
  assembleDebug --console=plain -q
```

Output: `app/build/outputs/apk/debug/app-debug.apk`. `local.properties` pins `sdk.dir` to `mobile_session\tools\sdk`.

## adb (D:\platform-tools\adb.exe)

```bash
# install — WINDOWS path required, /d/… fails with "failed to stat"
D:/platform-tools/adb.exe install -r "D:\IVAC\Claude\ivac_ind_v4\ivac_ind\mobile_session\app\app\build\outputs\apk\debug\app-debug.apk"

# launch (MainActivity only — VpnSetupActivity/ProfileActivity are exported=false)
D:/platform-tools/adb.exe shell am start -n com.ivac.mobile/.MainActivity

# screenshot
D:/platform-tools/adb.exe exec-out screencap -p > screen.png

# UI tree → exact bounds (BEST way to target taps)
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell uiautomator dump /sdcard/ui.xml
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell "cat /sdcard/ui.xml" | tr '<' '\n' | grep -oE 'text="VPN"[^>]*bounds="[^"]*"'

# genuine input (clears Turnstile where synthetic taps fail)
D:/platform-tools/adb.exe shell input tap X Y
D:/platform-tools/adb.exe shell input swipe X1 Y1 X2 Y2

# logcat
D:/platform-tools/adb.exe logcat -s IVAC:* IVAC-VPN:* IVAC-NORD:*
```

## Git-Bash/adb gotchas (all previously hit)

- `adb install` → pass `D:\…`, not `/d/…`.
- `uiautomator dump` / remote `cat` → prefix `MSYS_NO_PATHCONV=1` or paths get mangled.
- Floating windows (YouTube PiP etc.) eat taps — verify bounds don't overlap before concluding a tap failed.
- `install -r` kills the process, keeps data; engine auto-resumes via `running_profile` setting.
- Device occasionally drops off adb — `adb devices` to confirm before assuming a hang.

## Conventions

- **Port, don't reinvent**: mobile behavior mirrors `src/index.ts` (states, strike semantics, API-first dates). When changing booking logic, check the desktop equivalent first.
- The `Driver` interface in `Engine.kt` is the only engine↔UI seam — keep it.
- `dryRun` must never click the final submit.
- VPN is embedded WireGuard only (NordLynx). OpenVPN support was deliberately removed — do not reintroduce.
- Secrets live in `Store` (AndroidKeyStore AES-GCM). Never log `wg_privkey`, `nord_token`, `tg_token`, passwords.
- Turnstile: solver v2 = ~8s auto-resolve grace → ~90s revolving-tap loop (re-evaluates `CF_BOX` per poll); curved `dispatchGesture` strokes; coordinate mapping is `(css − visualViewport.offset) × (dpr × vvScale)` — verified. Escalation: 2 rounds → full-screen notification; 5 rounds → rotate+reload.
- VPN rotation is **ordered** (`rotationIndex` over the `TARGET_COUNTRIES`-sorted pool — US→UK→FR→DK→CZ→PNG→CR first), not random. Same-exit-IP → next country.
- Telegram fires on 3 events only: `sendOfcBooked`, `sendConsularStage`, `sendConsularBooked`. `notifyEvent` is Android-local — never wire it to Telegram.
- `direct_api` store key (header `API` button) toggles the custom-actions sweep; default OFF.

## Seed profiles headlessly

```bash
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe push profiles_import.json /sdcard/
D:/platform-tools/adb.exe shell "run-as com.ivac.mobile sh -c 'cat /sdcard/profiles_import.json > files/profiles_import.json'"
# app imports + deletes the file on next launch
```
