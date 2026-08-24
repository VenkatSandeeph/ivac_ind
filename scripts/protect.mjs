import { build } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const protectedDir = path.join(root, "protected");

fs.rmSync(protectedDir, { recursive: true, force: true });
fs.mkdirSync(protectedDir, { recursive: true });

console.log("1. Bundling TypeScript application...");

await build({
  entryPoints: [path.join(root, "src/index.ts")],

  bundle: true,

  platform: "node",

  format: "cjs",

  target: "node22",

  outfile: path.join(protectedDir, "app.bundle.js"),

  sourcemap: false,

  minify: false,

  // Keep these external for now.
  // They will be supplied by node_modules at runtime.
  external: [
    "playwright",
    "playwright-core",
    "electron"
  ]
});

console.log("Bundle created:");
console.log("  protected/app.bundle.js");

console.log("");
console.log("2. Obfuscating application...");

const input = fs.readFileSync(
  path.join(protectedDir, "app.bundle.js"),
  "utf8"
);

const result = JavaScriptObfuscator.obfuscate(input, {
  compact: true,

  controlFlowFlattening: false,

  deadCodeInjection: false,

  stringArray: true,

  stringArrayEncoding: ["base64"],

  stringArrayThreshold: 0.75,

  rotateStringArray: true,

  identifierNamesGenerator: "hexadecimal",

  renameGlobals: false,

  selfDefending: false,

  disableConsoleOutput: false,

  sourceMap: false
});

fs.writeFileSync(
  path.join(protectedDir, "app.js"),
  result.getObfuscatedCode()
);

// Delete readable bundle.
fs.rmSync(
  path.join(protectedDir, "app.bundle.js"),
  { force: true }
);

console.log("Protected application created:");
console.log("  protected/app.js");

console.log("");
console.log("Protection build completed.");