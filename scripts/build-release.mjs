/**
 * build-release.mjs -- Full release build for IVAC Launcher
 *
 * Pipeline:
 *   1. Compile TypeScript (tsc)
 *   2. Bundle + obfuscate core script (esbuild + javascript-obfuscator)
 *   3. Compile core to native exe (@yao-pkg/pkg)
 *   4. Obfuscate UI JS files (in-place, temporary)
 *   5. Package Electron app (electron-builder → dir target)
 *   6. Restore original UI files
 *   7. Create distributable zip
 *
 * Output: $IVAC_RELEASE_DIR/win-unpacked/  (ready to run)
 *         $IVAC_RELEASE_DIR/IVAC-Launcher.zip (distributable)
 */
import JavaScriptObfuscator from "javascript-obfuscator";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const releaseDir = process.env.IVAC_RELEASE_DIR || "release";
const UI_JS_FILES = ["ui/main.js", "ui/renderer.js"];

// Parse --mode=dev|client argument (also supports IVAC_BUILD_MODE env var)
const modeArg = process.argv.find(a => a.startsWith("--mode="));
const buildMode = (modeArg ? modeArg.split("=")[1] : process.env.IVAC_BUILD_MODE) || "dev";
if (buildMode !== "dev" && buildMode !== "client") {
  console.error(`Invalid build mode: ${buildMode}. Use --mode=dev or --mode=client`);
  process.exit(1);
}
// Pass to protect.mjs via env var
process.env.IVAC_BUILD_MODE = buildMode;

function run(cmd, env) {
  console.log("  > " + cmd);
  execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
}

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    // stringArray disabled — see protect.mjs for rationale
    stringArray: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: false,
    disableConsoleOutput: false,
    sourceMap: false
  }).getObfuscatedCode();
}

console.log("========================================");
console.log(`  IVAC Launcher -- Release Build (${buildMode} mode)`);
console.log("========================================\n");

// ---- Step 1: Compile TypeScript ----
console.log("[1/6] Compiling TypeScript...");
run("npx tsc -p tsconfig.json");

// ---- Step 2: Bundle + obfuscate core script ----
console.log("\n[2/6] Bundling and obfuscating core script...");
run("node scripts/protect.mjs");

// ---- Step 3: Compile core to exe ----
// --no-bytecode --public: embed source code as plain JS instead of V8 bytecode.
// V8 bytecode snapshots strip Function.prototype.toString() source, replacing
// it with "function name() { [native code] }". This breaks Playwright/Patchright's
// serialization check (new Function("(" + fn.toString() + ")")) for every
// page.evaluate(), evaluateAll(), and waitForFunction() call.
// The source is already minified by esbuild, so readability is minimal.
console.log("\n[3/6] Compiling core script to native executable...");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
run("npx @yao-pkg/pkg -t node24-win-x64 --no-bytecode --public -o dist/ivac-core.exe protected/app.js");

// Verify the exe was created
const exePath = path.join(root, "dist", "ivac-core.exe");
if (!fs.existsSync(exePath)) {
  console.error("ERROR: ivac-core.exe was not created!");
  process.exit(1);
}
const exeSizeMB = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log("  Core executable: dist/ivac-core.exe (" + exeSizeMB + " MB)");

// ---- Step 4: UI modifications for client builds + backup ----
// NOTE: UI obfuscation is disabled because javascript-obfuscator breaks
// async/callback patterns in renderer.js. The core logic is already
// protected via @yao-pkg/pkg. UI files ship as plain (but minified) JS.
console.log(`\n[4/6] UI preparation (build mode: ${buildMode})...`);
const backups = {};
for (const relPath of UI_JS_FILES) {
  const absPath = path.join(root, relPath);
  backups[absPath] = fs.readFileSync(absPath, "utf8");
  console.log("  Backed up: " + relPath);
}

// In client mode, disable DevTools and hide the debug panel.
// These modifications are in-place on the backed-up files and restored
// after electron-builder finishes (see Step 6 below).
if (buildMode === "client") {
  console.log("  Applying client-mode UI modifications...");

  // main.js: disable DevTools auto-open and set devTools: false
  const mainPath = path.join(root, "ui/main.js");
  let mainJs = fs.readFileSync(mainPath, "utf8");
  const devToolsOpenCount = (mainJs.match(/mainWindow\.webContents\.openDevTools\([^)]*\);/g) || []).length;
  mainJs = mainJs.replace(
    /mainWindow\.webContents\.openDevTools\([^)]*\);/g,
    "// DevTools disabled in client build"
  );
  mainJs = mainJs.replace(
    /devTools:\s*true/g,
    "devTools: false"
  );
  fs.writeFileSync(mainPath, mainJs);
  console.log(`    main.js: removed ${devToolsOpenCount} openDevTools call(s), set devTools: false`);

  // renderer.js: hide debug panel
  const rendererPath = path.join(root, "ui/renderer.js");
  let rendererJs = fs.readFileSync(rendererPath, "utf8");
  const debugPanelCount = (rendererJs.match(/if \(dp\) dp\.style\.display = 'block';/g) || []).length;
  rendererJs = rendererJs.replace(
    /if \(dp\) dp\.style\.display = 'block';/g,
    "if (dp) dp.style.display = 'none'; // hidden in client build"
  );
  // Hide the dev-only "Special Window" header toggle in client builds.
  const specialWinCount = (rendererJs.match(/specialWinLabel\.style\.display = '';/g) || []).length;
  rendererJs = rendererJs.replace(
    /specialWinLabel\.style\.display = '';/g,
    "specialWinLabel.style.display = 'none'; // hidden in client build"
  );
  fs.writeFileSync(rendererPath, rendererJs);
  console.log(`    renderer.js: hidden ${debugPanelCount} debug panel display(s), ${specialWinCount} dev-only toggle(s)`);
} else {
  console.log("  Dev mode: no UI modifications needed.");
}

// ---- Step 5: Package with electron-builder (dir target, no signing) ----
console.log("\n[5/7] Packaging Electron app...");

// Clean ${releaseDir}/win-unpacked before rebuild, skipping locked dirs (e.g. chrome-debug)
const unpackedPre = path.join(root, releaseDir, "win-unpacked");
if (fs.existsSync(unpackedPre)) {
  try {
    fs.rmSync(unpackedPre, { recursive: true, force: true });
  } catch {
    console.warn("  Could not fully remove " + releaseDir + "/win-unpacked (files may be locked by Chrome).");
    console.warn("  Continuing — electron-builder will overwrite what it can.");
  }
}

let ebFailed = false;
try {
  const ebConfig = process.env.IVAC_EB_CONFIG || "";
  const ebConfigArg = ebConfig ? " " + ebConfig : "";
  run("npx electron-builder --win --dir --config" + ebConfigArg, {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    WIN_CSC_LINK: ""
  });
} catch (e) {
  // electron-builder may fail at the rcedit/signing step even though the
  // directory output was already created successfully. Check for it.
  const unpackedCheck = path.join(root, releaseDir, "win-unpacked", "resources", "app.asar");
  if (fs.existsSync(unpackedCheck)) {
    console.warn("  electron-builder exited with errors (likely winCodeSign symlink issue)");
    console.warn("  but the packaged output was created successfully — continuing.");
    ebFailed = true;
  } else {
    // Restore UI files before re-throwing
    for (const [absPath, original] of Object.entries(backups)) {
      fs.writeFileSync(absPath, original);
    }
    throw e;
  }
} finally {
  // ---- Step 6: Restore original UI files ----
  console.log("\n[6/7] Restoring original UI files...");
  for (const [absPath, original] of Object.entries(backups)) {
    fs.writeFileSync(absPath, original);
    console.log("  Restored: " + path.relative(root, absPath));
  }
}

// ---- Step 7: Create distributable zip ----
const unpackedDir = path.join(root, releaseDir, "win-unpacked");
const zipPath = path.join(root, releaseDir, "IVAC-Launcher.zip");

if (fs.existsSync(unpackedDir)) {
  console.log("\n[7/7] Creating distributable zip...");

  // Remove runtime artifacts that should never ship (e.g. chrome-debug user data)
  const chromeDebugDir = path.join(unpackedDir, "chrome-debug");
  if (fs.existsSync(chromeDebugDir)) {
    try {
      fs.rmSync(chromeDebugDir, { recursive: true, force: true });
      console.log("  Removed stale chrome-debug dir from release");
    } catch {
      console.warn("  Warning: could not remove chrome-debug dir (Chrome may be running).");
      console.warn("  Close Chrome and re-run, or manually delete " + releaseDir + "/win-unpacked/chrome-debug.");
    }
  }

  try { fs.unlinkSync(zipPath); } catch {}
  run(
    `powershell -NoProfile -Command "Compress-Archive -Path '${unpackedDir}\\*' -DestinationPath '${zipPath}' -Force"`
  );
  const zipSizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log("  Created: " + releaseDir + "/IVAC-Launcher.zip (" + zipSizeMB + " MB)");
} else {
  console.warn("\n[7/7] Skipped zip — " + releaseDir + "/win-unpacked not found.");
}

console.log("\n========================================");
console.log("  Release build complete!");
console.log("  Output:");
console.log("    " + releaseDir + "/win-unpacked/  (run IVAC Launcher.exe)");
console.log("    " + releaseDir + "/IVAC-Launcher.zip  (distribute this)");
console.log("========================================");
