# US Visa Scheduling Automation

This project automates the US Visa scheduling flow using Playwright and a real Chrome browser.

## Setup

1. Install dependencies:

   ```bash
   cd D:\IVAC\V2
   npm install
   ```

2. Copy the example config:

   ```bash
   copy config.example.json config.local.json
   ```

3. Edit `config.local.json` with your values.

4. Optionally set environment variables instead of `config.local.json`:

   - `AUTH_URL`
   - `USERNAME`
   - `PASSWORD`
   - `APPOINTMENT_CITY`
   - `APPOINTMENT_MONTH`
   - `APPOINTMENT_YEAR`
   - `APPOINTMENT_START_DATE`
   - `APPOINTMENT_END_DATE`
   - `CHROME_EXECUTABLE`
   - `CHROME_USER_DATA_DIR`
   - `CHROME_REMOTE_DEBUG_PORT`
   - `MAX_SLOT_ATTEMPTS`
   - `SLOT_RETRY_DELAY_MS`
   - `CLOUDFLARE_WAIT_MS`
   - `DEBUG_NETWORK`

## Recommended Chrome launch

The script can launch Chrome automatically using the configured executable and user data directory.
If you want to reuse an existing Chrome session, start Chrome manually with:

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\chrome-debug"
```

## Running the automation

```bash
npm start
```

## Building a single Windows executable

You can package the compiled Node program into a single Windows `.exe` using `pkg`.

1. Install dev dependencies (or run from CI):

```bash
npm install --omit=optional
```

2. Build TypeScript and create the executable:

```bash
npm run build:exe
```

This produces `dist/IVAC.exe`. Place `config.local.json` alongside `dist/IVAC.exe` and run:

```powershell
.\dist\IVAC.exe
```

Notes:
- The exe bundles the Node runtime and your compiled code, but not the Playwright browser binaries. For automation that launches a local browser, ensure a compatible Chrome/Chromium is installed on the target machine or use the script to connect to an existing remote-debugging Chrome (see `chromeRemoteDebugPort` in `config.local.json`).
- `config.local.json` must be present in the same working directory as the executable; the program reads `config.local.json` from `process.cwd()`.
- For cross-platform packaging or advanced bundling of Playwright browsers, consider shipping browser binaries separately or running on a machine with Playwright installed.

## What it does

- opens Chrome with remote debugging enabled
- navigates to the configured authentication URL
- signs in with provided credentials
- answers configured security questions
- detects Cloudflare / human verification challenges, including inline checkbox flows
- optionally auto-solves Cloudflare checkbox challenges using `ghost-cursor`
- navigates to the OFC Schedule page
- selects the configured city
- selects the configured calendar month/year when available
- chooses a valid appointment date within the requested date range only
- selects the first visible available time slot
- waits for the submit button to become enabled, then submits the appointment

## Diagnostics

Artifacts are saved to `artifacts/` on failure:

- `screenshots/`
- `logs/`
- `traces/`

## Notes

- Do not store secrets in source control.
- `config.local.json` is ignored by `.gitignore`.
- If Cloudflare verification appears, the script pauses and waits for manual completion.
