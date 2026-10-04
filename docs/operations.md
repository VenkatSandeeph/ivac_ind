# Operations — Build, Deploy, Debug

## Repo layout

```
ivac_ind/
├── src/ ui/ scripts/        # desktop core + Electron launcher + build tooling
├── mobile_session/
│   ├── app/                 # Android project (Gradle root: mobile_session/app)
│   ├── tools/               # LOCAL toolchain — NOT part of PATH
│   │   ├── jdk/jdk-17.0.20.1+1
│   │   ├── gradle/gradle-8.9
│   │   ├── gradle-home/     # GRADLE_USER_HOME (caches, daemon)
│   │   └── sdk/             # Android SDK (build-tools, platforms)
│   └── profiles_import.json # seed file for app bootstrap import
├── release*/ dist/ protected/   # build outputs (keep — live profiles inside release dirs)
├── chrome-debug*/           # Chrome user-data dirs
└── docs/ .devin/
```

## Desktop

```bash
npm install
npm run prepare          # patchright install chromium
npm start                # headless core: tsx src/index.ts
npm run ui:start         # Electron launcher (spawns core per profile)
npm run build            # tsc typecheck → dist/
npm run protect          # esbuild bundle+minify → protected/
npm run build:core       # pkg → dist/ivac-core.exe
npm run build:release    # electron-builder → release<N>/win-unpacked/ + zip
npm run build:dev        # same, --mode=dev
npm run build:client     # same, --mode=client
```

- In dev, `ui/main.js` runs `node_modules/.bin/tsx.cmd src/index.ts` per profile — `dist/` is only needed for packaged builds.
- winCodeSign symlink errors during electron-builder are tolerated; the unpacked app + zip still produce.
- Requires NordVPN desktop app running + logged in for `src/nordvpn.ts` rotation; **disable the Nord kill switch**.
- `nordvpn.exe` prints no stdout for `status`/`countries`/`cities` on this build (GUI wrapper) — city lists come from `api.nordvpn.com/v1/servers/countries`; verify connects via public IP (`api.ipify.org`) **plus geo** (`ip-api.com/json/<ip>` — a wrong-country exit means the target arg was ignored).

## Android — build

The toolchain is vendored under `mobile_session/tools/` — there is no `gradlew` wrapper and `gradle`/`java` are not on PATH. From Git Bash:

```bash
cd /d/IVAC/Claude/ivac_ind_v4/ivac_ind/mobile_session/app

JAVA_HOME="D:\\IVAC\\Claude\\ivac_ind_v4\\ivac_ind\\mobile_session\\tools\\jdk\\jdk-17.0.20.1+1" \
GRADLE_USER_HOME="D:\\IVAC\\Claude\\ivac_ind_v4\\ivac_ind\\mobile_session\\tools\\gradle-home" \
/d/IVAC/Claude/ivac_ind_v4/ivac_ind/mobile_session/tools/gradle/gradle-8.9/bin/gradle \
  assembleDebug --console=plain -q
```

APK output: `mobile_session/app/app/build/outputs/apk/debug/app-debug.apk`.

`local.properties` already pins `sdk.dir=mobile_session\tools\sdk`.

## Android — install & debug (adb at `D:\platform-tools\adb.exe`)

```bash
# Install — MUST pass a WINDOWS path (adb.exe is Win32; /d/… Git-Bash paths fail)
D:/platform-tools/adb.exe install -r "D:\IVAC\Claude\ivac_ind_v4\ivac_ind\mobile_session\app\app\build\outputs\apk\debug\app-debug.apk"

# Launch
D:/platform-tools/adb.exe shell am start -n com.ivac.mobile/.MainActivity

# Screenshot → view
D:/platform-tools/adb.exe exec-out screencap -p > screen.png

# UI tree (get exact button bounds — most reliable tap targeting)
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell uiautomator dump /sdcard/ui.xml
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe shell "cat /sdcard/ui.xml" | tr '<' '\n' | grep -oE 'text="VPN"[^>]*bounds="[^"]*"'

# Input injection (genuine input — clears Turnstile)
D:/platform-tools/adb.exe shell input tap <x> <y>
D:/platform-tools/adb.exe shell input swipe <x1> <y1> <x2> <y2>

# Logcat (app tag)
D:/platform-tools/adb.exe logcat -s IVAC:* IVAC-VPN:* IVAC-NORD:*

# Seed profiles without the UI (app imports on launch, then deletes the file)
MSYS_NO_PATHCONV=1 D:/platform-tools/adb.exe push profiles_import.json /sdcard/
D:/platform-tools/adb.exe shell "run-as com.ivac.mobile sh -c 'cat /sdcard/profiles_import.json > files/profiles_import.json'"
```

### adb gotchas (learned the hard way)

- `adb install` needs a **Windows** path (`D:\…`), not `/d/…`.
- `uiautomator dump`/`cat` get path-mangled by Git Bash — prefix `MSYS_NO_PATHCONV=1`.
- `VpnSetupActivity`/`ProfileActivity` are `exported="false"` — cannot be `am start`ed; navigate via the VPN/EDIT buttons (use uiautomator for bounds).
- `install -r` kills the running app but preserves data; the engine auto-resumes via `running_profile` on next launch.
- Floating windows (e.g. YouTube PiP) eat taps — check bounds overlap before assuming a tap failed.

## On-device flows

**First VPN provision (once):** app → VPN → LOGIN (Nord account) → GET KEY (generates access token on dashboard → fetches NordLynx key via API) → SERVERS (caches ≤40 WG servers) → CONNECT (grants Android VPN consent once). Later sessions: CONNECT/ROTATE/DISC directly.

**Run automation:** tap profile → **START &lt;name&gt;**. Enable the accessibility-service prompt for automatic Turnstile taps; allow battery exemption for background running.

**Stop:** **STOP** button, or VPN screen → **DISC** for the tunnel.

## Logs & artifacts

| Where | What |
|---|---|
| App log pane | Timestamped engine/JS/net log (primary debugging trail) |
| `files/slot-observations.jsonl` | Calendar-visibility records (mobile) |
| `logs/slot-observations.jsonl` | Same, desktop |
| `artifacts/` | Desktop screenshots/dumps/traces |
| `*.ivac-*` root files | Desktop runtime state (regenerable) |
| Logcat `IVAC*` | Full app + VPN + Nord logs |
