#!/usr/bin/env node
/**
 * smoke.mjs — 启动验证脚本
 *
 * 1. spawn apps/server（默认 9527）
 * 2. 轮询 GET /api/system/status 200（只验证 HTTP 可达，不依赖 ready 字段），超时 30s
 * 3. spawn apps/web（vite preview --port 5173）
 * 4. 轮询 GET http://127.0.0.1:5173/ 200，超时 30s
 * 5. 两端均 200 → SIGTERM 子进程 → exit 0
 *
 * 不依赖临时数据目录（用默认 data/），只验证启动链路。
 */

import { spawn, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SERVER_PORT = "9527";
const WEB_PORT = "5173";
const POLL_INTERVAL = 1000;
const TIMEOUT = 30000;

function safeKill(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (platform() === "win32") {
      execSync(`taskkill /pid ${proc.pid} /f /t 2>nul`, { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* already dead */
  }
}

async function waitFor(url, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}

async function main() {
  console.log("[smoke] starting server…");
  const serverProc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: resolve(root, "apps/server"),
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PORT: SERVER_PORT },
  });

  console.log("[smoke] waiting for server ready…");
  const serverOk = await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/system/status`, TIMEOUT);
  if (!serverOk) {
    console.error("[smoke] server not ready in time");
    safeKill(serverProc);
    process.exit(1);
  }
  console.log("[smoke] server ready");

  // Build web first
  console.log("[smoke] building web…");
  const build = spawn("npx", ["vite", "build"], {
    cwd: resolve(root, "apps", "web"),
    stdio: "inherit",
    shell: true,
  });
  await new Promise((resolveBuild, rejectBuild) => {
    build.on("close", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`vite build failed (exit ${code})`));
    });
  });

  console.log("[smoke] starting web preview…");
  const webProc = spawn("npx", ["vite", "preview", "--port", WEB_PORT], {
    cwd: resolve(root, "apps", "web"),
    stdio: "inherit",
    shell: true,
  });

  console.log("[smoke] waiting for web ready…");
  const webOk = await waitFor(`http://127.0.0.1:${WEB_PORT}/`, TIMEOUT);
  if (!webOk) {
    console.error("[smoke] web not ready in time");
    safeKill(serverProc);
    safeKill(webProc);
    process.exit(1);
  }
  console.log("[smoke] web ready");

  // Both are up — clean shutdown
  console.log("[smoke] all systems ready");
  safeKill(serverProc);
  safeKill(webProc);
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
