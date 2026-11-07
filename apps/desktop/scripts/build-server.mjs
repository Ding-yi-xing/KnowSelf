/**
 * build-server.mjs — Bundle Hono server into a standalone delivery.
 *
 * 1. esbuild bundles all JS (including workspace packages), externalizes native modules
 * 2. Copies native .node files + essential node_modules alongside the bundle
 * 3. Copies portable node.exe
 * 4. Output: binaries/server-bundled.cjs + binaries/node_modules/ + binaries/node-win64.exe
 */

import * as esbuild from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
} from "fs";
import { resolve, dirname, basename, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const OUT = resolve(__dirname, "..", "src-tauri", "binaries");
const NM = resolve(OUT, "node_modules");
const PACKAGES = resolve(ROOT, "packages");

mkdirSync(OUT, { recursive: true });

// ── 1. Bundle: inline all JS deps, externalize native-only packages ──
const nativePkgs = [
  "better-sqlite3",
  "onnxruntime-node",
  "@node-rs/jieba-win32-x64-msvc",
  "@node-rs/jieba",
  "@xenova/transformers",
  "sqlite-vec",
];

const entry = resolve(ROOT, "apps", "server", "dist", "index.js");
const outfile = resolve(OUT, "server-bundled.cjs");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile,
  format: "cjs",
  external: nativePkgs,
  sourcemap: false,
  minify: false,
});
console.log("✓ Bundled server JS →", outfile);

// ── 2. Helper: copy a node_module subtree ──
function copyModule(name, fromDir = ROOT) {
  const src = resolve(fromDir, "node_modules", name.replace("/", "\\"));
  const dst = resolve(NM, name);
  if (!existsSync(src)) {
    console.log(`  ✗ ${name} not found`);
    return;
  }
  copyRecursive(src, dst);
  const size = dirSize(dst);
  console.log(`  ✓ ${name}  (${(size / 1024).toFixed(0)} KB)`);
}

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  copyRecursive(src, dst);
}

function copyRecursive(src, dst) {
  if (!existsSync(src)) return;
  const st = lstatSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      copyRecursive(join(src, name), join(dst, name));
    }
  } else if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

function dirSize(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, f.name);
    if (f.isDirectory()) total += dirSize(fp);
    else if (f.isFile()) total += statSync(fp).size;
  }
  return total;
}

// ── 3. Copy native module binaries ──
// better-sqlite3 is essential for any DB access
copyModule("better-sqlite3");
// sqlite-vec provides the vec0 virtual table
copyModule("sqlite-vec");
copyModule("sqlite-vec-windows-x64"); // BUG-C: platform native sub-package (vec0.dll)
// @node-rs/jieba is needed for FTS5 tokenizer (retriever)
copyModule("@node-rs/jieba-win32-x64-msvc");
// The @node-rs/jieba JS wrapper that resolves the platform-specific binary
copyModule("@node-rs/jieba");
copyModule("@xenova/transformers"); // BUG-A: xenova embeddings runtime dependency
copyModule("onnxruntime-node"); // BUG-A: @xenova/transformers native dep
copyModule("onnxruntime-common"); // BUG-A: onnxruntime-node dependency

// ── 4. Copy workspace packages ──
for (const name of [
  "contracts",
  "config",
  "profile-store",
  "context-router",
  "provider-adapter",
  "mcp-host",
  "ingestion",
]) {
  const srcDist = resolve(PACKAGES, name, "dist");
  const srcPkg = resolve(PACKAGES, name, "package.json");
  const dstDir = resolve(NM, `@knowself/${name}`);
  if (existsSync(srcDist)) copyDir(srcDist, resolve(dstDir, "dist"));
  if (existsSync(srcPkg)) copyFileSync(srcPkg, resolve(dstDir, "package.json"));
  console.log(`  ✓ @knowself/${name}`);
}

// ── 5. Copy common deps needed at runtime ──
// These are workspace-level deps the server requires
for (const pkg of [
  "zod",
  "picocolors",
  "proper-lockfile",
  "mime-types",
  "mime-db",
  "bindings",
  "file-uri-to-path",
]) {
  copyModule(pkg);
}

// ── 6. Copy @hono/node-server + hono (the server framework) ──
copyModule("@hono/node-server");
copyModule("hono");

// ── 7. Copy node.exe ──
copyFileSync(process.execPath, resolve(OUT, "node-win64.exe"));
console.log("✓ node-win64.exe");

// ── 8. Create launcher batch file (for testing outside Tauri) ──
writeFileSync(
  resolve(OUT, "start-server.bat"),
  `@echo off\nset NODE_PATH=%~dp0node_modules\n"%~dp0node-win64.exe" "%~dp0server-bundled.cjs"\n`,
);
console.log("✓ start-server.bat");

const total = dirSize(OUT);
console.log(`\n── Total: ${(total / 1024 / 1024).toFixed(1)} MB ──`);
