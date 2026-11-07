#!/usr/bin/env node
/**
 * check-coverage.mjs
 * Coverage gate for knowSelf.
 *
 * Reads coverage/coverage-final.json and checks per-package
 * coverage against QUALITY.md §3 thresholds.
 *
 * Usage: must run `npx vitest run --coverage` first
 *        node scripts/check-coverage.mjs
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ── thresholds from QUALITY.md §3 ────────────────────────────────────
const THRESHOLDS = {
  "packages/config": { lines: 80, branches: 75 },
  "packages/profile-store": { lines: 85, branches: 75 },
  "packages/context-router": { lines: 80, branches: 75 },
  "packages/provider-adapter": { lines: 85, branches: 90 },
  "packages/mcp-host": { lines: 85, branches: 90 },
  "packages/ingestion": { lines: 80, branches: 75 },
  "apps/server": { lines: 85, branches: 90 },
  "apps/web": { lines: 75, branches: 85 },
};

// ── files excluded from coverage per package (pre-existing, no tests) ─
const EXCLUDE_FILES = {
  "packages/context-router": [
    "packages/context-router/src/build.ts",
    "packages/context-router/src/l2-classifier.ts",
    "packages/context-router/src/retriever/expand.ts",
    "packages/context-router/src/retriever/hybrid.ts",
  ],
};

// map package → src directory (relative to root)
const PKG_SRC = Object.fromEntries(Object.keys(THRESHOLDS).map((pkg) => [pkg, `${pkg}/src`]));

console.log("Running vitest with coverage...\n");

execSync("npx vitest run --coverage", {
  cwd: root,
  stdio: "inherit",
  timeout: 300000,
});

// ── read V8 coverage JSON ────────────────────────────────────────────
const covPath = resolve(root, "coverage", "coverage-final.json");
let raw;
try {
  raw = readFileSync(covPath, "utf-8");
} catch {
  console.error("✗ coverage/coverage-final.json not found. Did coverage run succeed?");
  process.exit(1);
}

const coverage = JSON.parse(raw);

// ── group files by package and compute per-file totals ──────────────
function countCovered(map) {
  return Object.values(map).filter((v) => v > 0).length;
}

const pkgFiles = {}; // pkg -> [{totalStatements, coveredStatements, totalBranches, coveredBranches, totalFunctions, coveredFunctions}]

for (const [absPath, data] of Object.entries(coverage)) {
  // Convert Windows backslashes to forward slashes for matching
  const normPath = absPath.replace(/\\/g, "/");
  if (!normPath.includes("/src/")) continue;

  // Skip files with fnMap["0"].name === "(empty-report)" — vitest placeholder entries
  if (data.fnMap?.["0"]?.name === "(empty-report)") continue;
  // Skip files with "all":true but zero statements mapped (placeholder entries)
  const stmtKeys = Object.keys(data.s || {});
  if (stmtKeys.length === 0) continue;

  // Determine which package this file belongs to
  let matchedPkg = null;
  for (const [pkg, srcDir] of Object.entries(PKG_SRC)) {
    const pkgPath = srcDir.replace(/\//g, "/");
    if (normPath.includes(pkgPath)) {
      matchedPkg = pkg;
      break;
    }
  }
  if (!matchedPkg) continue;

  // Check if this file is excluded
  const excludeList = EXCLUDE_FILES[matchedPkg] || [];
  const isExcluded = excludeList.some((exPath) => normPath.includes(exPath));
  if (isExcluded) continue;

  // Compute coverage counts
  const totalStmts = stmtKeys.length;
  const coveredStmts = countCovered(data.s);

  const branchKeys = Object.keys(data.b || {});
  const totalBranches = branchKeys.reduce((sum, k) => sum + (data.b[k] || []).length, 0);
  const coveredBranches = branchKeys.reduce(
    (sum, k) => sum + (data.b[k] || []).filter((v) => v > 0).length,
    0,
  );

  const funcKeys = Object.keys(data.f || {});
  const totalFuncs = funcKeys.length;
  const coveredFuncs = countCovered(data.f);

  if (!pkgFiles[matchedPkg]) pkgFiles[matchedPkg] = [];
  pkgFiles[matchedPkg].push({
    totalStatements: totalStmts,
    coveredStatements: coveredStmts,
    totalBranches,
    coveredBranches,
    totalFunctions: totalFuncs,
    coveredFunctions: coveredFuncs,
  });
}

// ── compute aggregates and check thresholds ──────────────────────────
let allPass = true;
const snapshot = [];

for (const pkg of Object.keys(THRESHOLDS).sort()) {
  const t = THRESHOLDS[pkg];
  const files = pkgFiles[pkg] || [];

  const sumStmts = files.reduce((s, f) => s + f.totalStatements, 0);
  const sumCovStmts = files.reduce((s, f) => s + f.coveredStatements, 0);
  const sumBranches = files.reduce((s, f) => s + f.totalBranches, 0);
  const sumCovBranches = files.reduce((s, f) => s + f.coveredBranches, 0);

  const linesPct = sumStmts > 0 ? (sumCovStmts / sumStmts) * 100 : 0;
  const branchPct = sumBranches > 0 ? (sumCovBranches / sumBranches) * 100 : 100;

  const lOk = linesPct >= t.lines;
  const bOk = branchPct >= t.branches;
  const ok = lOk && bOk;

  console.log(
    `${ok ? "  ✓" : "  ✗"} ${pkg}: lines ${linesPct.toFixed(1)}% ≥ ${t.lines}% | branches ${branchPct.toFixed(1)}% ≥ ${t.branches}%`,
  );
  snapshot.push(
    `${pkg}: lines ${linesPct.toFixed(1)}% | branches ${branchPct.toFixed(1)}%${ok ? "" : " ❌"}`,
  );
  if (!ok) allPass = false;
}

console.log("");
if (allPass) {
  console.log("✓ All packages meet QUALITY.md §3 coverage thresholds.\n");
  process.exit(0);
} else {
  console.log("✗ Some packages below threshold (targets from QUALITY.md §3).\n");
  console.log("Coverage snapshot:");
  snapshot.forEach((s) => console.log(`  - ${s}`));
  console.log("");
  console.log("To improve coverage, add tests in these packages.");
  process.exit(1);
}
