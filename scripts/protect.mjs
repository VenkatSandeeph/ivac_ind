import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const protectedDir = path.join(root, "protected");

fs.rmSync(protectedDir, { recursive: true, force: true });
fs.mkdirSync(protectedDir, { recursive: true });

// Shim for node:inspector — pkg strips this built-in from the compiled binary,
// but patchright-core requires it at module init time. This stub satisfies
// the require("inspector") call with harmless no-ops.
const inspectorShimBanner = `
if (typeof process.pkg !== 'undefined') {
  var _Module = require('module');
  var _origResolve = _Module._resolveFilename;
  _Module._resolveFilename = function(request) {
    if (request === 'inspector' || request === 'node:inspector') return 'pkg-inspector-shim';
    return _origResolve.apply(this, arguments);
  };
  require.cache['pkg-inspector-shim'] = {
    id: 'pkg-inspector-shim', filename: 'pkg-inspector-shim', loaded: true,
    exports: {
      Session: function Session() {
        this.connect = function() {};
        this.post = function(_m, _p, cb) { if (cb) cb(); };
        this.disconnect = function() {};
        this.on = function() {};
      },
      open: function() {},
      close: function() {},
      url: function() { return undefined; },
      console: { log: function() {}, warn: function() {}, error: function() {} }
    }
  };
}
`;

// Protection strategy:
// - esbuild minification (minifySyntax + minifyWhitespace + mangling) shortens
//   variable names and compacts the code. This is Playwright-safe because it
//   preserves function expression boundaries and doesn't inject outer-scope
//   references into evaluate callbacks.
// - The primary source-code protection is the @yao-pkg/pkg native binary
//   compilation (step 3 of the release pipeline). The source code is embedded
//   in a V8 snapshot inside the .exe — not accessible as readable JS.
// - javascript-obfuscator was removed because its transforms (even with
//   stringArray disabled) break Playwright's function serialization check
//   (new Function("(" + fn.toString() + ")") fails).

console.log("1. Bundling and minifying TypeScript application...");

// Build mode: 'client' (release) or 'dev' (development).
// Injected as a compile-time constant so the logger can suppress dev logs
// in client builds without runtime env var checks.
const buildMode = process.env.IVAC_BUILD_MODE || "dev";
console.log(`  Build mode: ${buildMode}`);

await build({
  entryPoints: [path.join(root, "src/index.ts")],

  bundle: true,

  platform: "node",

  format: "cjs",

  target: "node22",

  outfile: path.join(protectedDir, "app.js"),

  sourcemap: false,

  minify: true,

  keepNames: false,

  banner: { js: inspectorShimBanner },

  // Compile-time constants injected into the bundle.
  define: {
    "process.env.IVAC_BUILD_MODE": JSON.stringify(buildMode)
  },

  // Keep these external — supplied by node_modules at runtime.
  external: [
    "playwright",
    "playwright-core",
    "electron"
  ]
});

const outSize = (fs.statSync(path.join(protectedDir, "app.js")).size / 1024).toFixed(1);
console.log(`  protected/app.js (${outSize} KB)`);

console.log("");
console.log("Protection build completed.");