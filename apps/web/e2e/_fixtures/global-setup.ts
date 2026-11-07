/**
 * global-setup.ts — e2e 全局启动
 *
 * 1. 创建临时数据目录
 * 2. spawn apps/server（KNOWSELF_E2E_MODE=1, PORT=9527）
 * 3. build + spawn apps/web（vite preview --port 5173）
 * 4. 轮询两端 readiness（最多 30s）
 * 5. 将 PID 和 tmpDir 写入 globalThis.__KNOWSELF_E2E__
 */

import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SERVER_PORT = "9527";
const WEB_PORT = "5173";
const POLL_INTERVAL = 500;
const TIMEOUT = 30000;

interface E2eGlobals {
  serverProc: ChildProcess;
  webProc: ChildProcess;
  tmpDir: string;
  browser: Browser;
  context: BrowserContext;
}

declare global {
  // eslint-disable-next-line no-var
  var __KNOWSELF_E2E__: E2eGlobals | undefined;
}

async function waitForUrl(url: string, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup(): Promise<void> {
  const tmpDir = mkdtempSync(resolve(tmpdir(), "knowself-e2e-"));
  const dataDir = resolve(tmpDir, "data");

  console.log(`[e2e] tmpDir: ${tmpDir}`);

  // 1. Build web first
  console.log("[e2e] building web…");
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const build = spawn("npx", ["vite", "build"], {
      cwd: resolve(ROOT, "apps", "web"),
      stdio: "pipe",
      shell: true,
    });
    let err = "";
    build.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    build.on("close", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`vite build failed: ${err}`));
    });
  });

  // 2. Start server
  console.log("[e2e] starting server…");
  const serverProc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: resolve(ROOT, "apps", "server"),
    stdio: "pipe",
    shell: true,
    env: {
      ...process.env,
      KNOWSELF_E2E_MODE: "1",
      KNOWSELF_DATA_DIR: dataDir,
      PORT: SERVER_PORT,
    },
  });
  serverProc.stdout.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

  // 3. Start web preview
  console.log("[e2e] starting web preview…");
  const webProc = spawn("npx", ["vite", "preview", "--port", WEB_PORT, "--strictPort"], {
    cwd: resolve(ROOT, "apps", "web"),
    stdio: "pipe",
    shell: true,
    env: {
      ...process.env,
      PORT: WEB_PORT,
    },
  });
  webProc.stdout.on("data", (d: Buffer) => process.stdout.write(`[web] ${d}`));
  webProc.stderr.on("data", (d: Buffer) => process.stderr.write(`[web] ${d}`));

  // 4. Wait for both to be ready
  console.log("[e2e] waiting for server…");
  await waitForUrl(`http://127.0.0.1:${SERVER_PORT}/api/system/status`, TIMEOUT);
  console.log("[e2e] server ready");

  console.log("[e2e] waiting for web…");
  await waitForUrl(`http://127.0.0.1:${WEB_PORT}/`, TIMEOUT);
  console.log("[e2e] web ready");

  // 5. Store globals
  globalThis.__KNOWSELF_E2E__ = {
    serverProc,
    webProc,
    tmpDir,
    browser: await chromium.launch(),
    context: null as unknown as BrowserContext,
  };
}
