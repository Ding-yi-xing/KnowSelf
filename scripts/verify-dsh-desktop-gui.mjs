#!/usr/bin/env node
/**
 * Real Desktop GUI acceptance for the frozen dsh/Electron runtime.
 *
 * This verifier never launches or closes Electron. Start the isolated CDP
 * instance with scripts/run-dsh-desktop.bat first, then run this script.
 * It accepts only a loopback CDP endpoint and limits UI actions to panel
 * navigation, graph viewport controls, view-mode selection, and local ability
 * filters. It never calls a write endpoint or invokes mining/sending controls.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = join(REPO_ROOT, "docs", "dsh-integration", "evidence");
const RESULT_PATH = join(EVIDENCE_DIR, "dsh-desktop-gui-result.json");
const GRAPH_SHOT_PATH = join(EVIDENCE_DIR, "dsh-desktop-graph.png");
const ABILITY_SHOT_PATH = join(EVIDENCE_DIR, "dsh-desktop-ability.png");
const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const PANEL_LABELS = ["人物", "图谱", "画像", "待整理", "日志", "资料"];
const FORBIDDEN_ABILITY_CONTROL_TEXT = /(分类|分组|社区)/;

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
};

function assertLoopbackEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`CDP 地址无效：${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (url.protocol !== "http:" || !isLoopback) {
    throw new Error("仅允许连接本机 http CDP 地址（例如 http://127.0.0.1:9222）");
  }
  return url.toString().replace(/\/$/, "");
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // The repository normally owns Playwright. An explicit external root is
    // supported only for a relocated package manager installation.
    const configured = process.env.DSH_PLAYWRIGHT_ROOT ?? process.env.PLAYWRIGHT_ROOT;
    const candidates = [
      configured,
      configured === undefined ? undefined : join(configured, "index.mjs"),
    ].filter((candidate) => candidate !== undefined && existsSync(candidate));

    for (const candidate of candidates) {
      try {
        return await import(pathToFileURL(candidate).href);
      } catch {
        // Try the next explicit candidate and retain the useful final failure.
      }
    }
    throw new Error("找不到 Playwright；请在仓库根目录安装依赖，或设置 DSH_PLAYWRIGHT_ROOT。");
  }
}

function shortError(error) {
  return error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
}

function imageHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function isVisible(locator) {
  return locator.count().then(async (count) => count > 0 && locator.first().isVisible().catch(() => false));
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const endpoint = assertLoopbackEndpoint(argument("cdp", process.env.DSH_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT));
  const result = {
    ok: false,
    endpoint,
    startedAt: new Date().toISOString(),
    page: null,
    panels: {},
    graph: {},
    ability: {},
    screenshots: {
      graph: "dsh-desktop-graph.png",
      ability: "dsh-desktop-ability.png",
    },
    unexpectedWriteRequests: [],
    errors: [],
  };

  let browser;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.connectOverCDP(endpoint);
    let page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("dsh-app://"));
    if (!page) throw new Error("未找到 dsh-app:// 页面；请确认隔离 Desktop 已启动并完成加载。");

    result.page = page.url();
    page.on("request", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        result.unexpectedWriteRequests.push({ method: request.method(), url: request.url() });
      }
    });

    for (const label of PANEL_LABELS) {
      const button = page.getByRole("button", { name: label, exact: true }).first();
      const exists = await button.count().then((count) => count > 0);
      if (!exists) {
        result.panels[label] = { ok: false, reason: "未找到导航按钮" };
        continue;
      }
      try {
        await button.click({ timeout: 10_000 });
        await page.waitForTimeout(350);
        result.panels[label] = { ok: true };
      } catch (error) {
        result.panels[label] = { ok: false, reason: shortError(error) };
      }
    }

    const graphNav = page.getByRole("button", { name: "图谱", exact: true }).first();
    await graphNav.click({ timeout: 10_000 });
    await page.waitForTimeout(750);

    const controls = page.locator('[data-testid="graph-controls"]');
    const zoomOut = page.locator('[data-testid="graph-zoom-out"]');
    const zoomIn = page.locator('[data-testid="graph-zoom-in"]');
    const zoomLevel = page.locator('[data-testid="graph-zoom-level"]');
    const reset = page.locator('[data-testid="graph-reset"]');
    const canvasWrap = page.locator('[data-testid="graph-canvas-wrap"]');

    // dsh switches keyed main panels asynchronously. A locator can resolve to
    // zero while React is replacing the preceding panel, so wait for the graph
    // controls before treating their absence as a product failure.
    await controls.waitFor({ state: "visible", timeout: 15_000 });

    const controlPresence = {
      controls: await isVisible(controls),
      zoomOut: await isVisible(zoomOut),
      zoomIn: await isVisible(zoomIn),
      zoomLevel: await isVisible(zoomLevel),
      reset: await isVisible(reset),
    };
    result.graph.controls = controlPresence;
    if (Object.values(controlPresence).some((present) => !present)) {
      throw new Error("图谱缩放控件不完整，无法进行 Desktop GUI 验收。");
    }

    const graphApi = await page.evaluate(async () => {
      try {
        const response = await fetch("/knowself-api/graph", { method: "GET" });
        if (!response.ok) return { ok: false, status: response.status };
        const payload = await response.json();
        const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
        return {
          ok: true,
          status: response.status,
          nodeCount: nodes.length,
          unnamedNodes: nodes.filter((node) => typeof node?.label !== "string" || node.label.trim() === "").length,
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    });
    result.graph.api = graphApi;

    // Canvas labels are not DOM text. Observe draw calls only for this run so
    // the evidence proves that names reached the real rendered canvas, rather
    // than merely existing in the JSON response. The original method is
    // restored before the verifier disconnects.
    await page.evaluate(() => {
      const marker = "__dshGuiLabelObserver";
      const proto = CanvasRenderingContext2D.prototype;
      const state = window[marker] ?? { labels: [], original: proto.fillText };
      state.labels = [];
      if (proto.fillText === state.original) {
        proto.fillText = function observedFillText(text, ...rest) {
          state.labels.push(String(text));
          return state.original.call(this, text, ...rest);
        };
      }
      window[marker] = state;
    });

    const personMode = page.getByRole("radio", { name: "人", exact: true }).first();
    if (!(await personMode.count().then((count) => count > 0))) {
      throw new Error("未找到“人”图谱视图模式。");
    }
    await personMode.click({ timeout: 10_000 });
    await page.waitForTimeout(1_500);

    const beforeZoom = (await zoomLevel.textContent())?.trim() ?? null;
    await zoomIn.click({ timeout: 10_000 });
    await page.waitForTimeout(150);
    const afterZoomIn = (await zoomLevel.textContent())?.trim() ?? null;
    await zoomOut.click({ timeout: 10_000 });
    await page.waitForTimeout(150);
    await reset.click({ timeout: 10_000 });
    await page.waitForTimeout(200);
    const afterReset = (await zoomLevel.textContent())?.trim() ?? null;
    result.graph.zoom = {
      before: beforeZoom,
      afterZoomIn,
      afterReset,
      changed: beforeZoom !== null && afterZoomIn !== null && beforeZoom !== afterZoomIn,
      reset: beforeZoom !== null && beforeZoom === afterReset,
    };

    const canvasBox = await canvasWrap.boundingBox().catch(() => null);
    result.graph.canvasBox = canvasBox;
    let pan = { attempted: false, changed: false, beforeHash: null, afterHash: null };
    if (canvasBox && graphApi.ok && graphApi.nodeCount > 0) {
      const beforeImage = await canvasWrap.screenshot({ timeout: 10_000 });
      await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + canvasBox.width * 0.72, canvasBox.y + canvasBox.height * 0.62, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(250);
      const afterImage = await canvasWrap.screenshot({ timeout: 10_000 });
      pan = {
        attempted: true,
        changed: imageHash(beforeImage) !== imageHash(afterImage),
        beforeHash: imageHash(beforeImage),
        afterHash: imageHash(afterImage),
      };
    }
    result.graph.pan = pan;
    result.graph.renderedLabels = await page.evaluate(() => {
      const marker = "__dshGuiLabelObserver";
      const state = window[marker];
      const labels = Array.from(new Set((state?.labels ?? []).map((label) => label.trim()).filter(Boolean)));
      if (state?.original) CanvasRenderingContext2D.prototype.fillText = state.original;
      delete window[marker];
      return { uniqueCount: labels.length, sample: labels.slice(0, 20) };
    });
    await page.screenshot({ path: GRAPH_SHOT_PATH, timeout: 20_000 });

    const abilityMode = page.getByRole("radio", { name: "我的能力", exact: true }).first();
    if (!(await abilityMode.count().then((count) => count > 0))) {
      throw new Error("未找到“我的能力”视图模式。");
    }
    await abilityMode.click({ timeout: 10_000 });
    // Ability graph layout is force-directed and needs materially longer than
    // an ordinary panel switch before its data-dependent filter bar settles.
    await page.waitForTimeout(4_500);

    const filterBar = page.locator('[data-testid="ability-filter-bar"]');
    const strength = page.locator('[data-testid="ability-filter-strength"]');
    const confidence = page.locator('[data-testid="ability-filter-confidence"]');
    const search = page.locator('[data-testid="ability-filter-search"]');
    const filterPresence = {
      bar: await isVisible(filterBar),
      strength: await isVisible(strength),
      confidence: await isVisible(confidence),
      search: await isVisible(search),
    };
    result.ability.filters = filterPresence;

    let noMatchState = null;
    if (filterPresence.search) {
      await search.fill("__dsh_gui_probe_no_match__");
      await page.waitForTimeout(250);
      noMatchState = await isVisible(page.locator('[data-testid="ability-no-match"]'));
      await search.fill("");
      await page.waitForTimeout(150);
    }
    result.ability.searchNoMatch = noMatchState;

    const forbiddenControls = await page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource);
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return Array.from(document.querySelectorAll("button, input, select, label, [role='radio'], [role='checkbox']"))
        .filter(visible)
        .map((element) => ({
          text: (element.textContent ?? "").trim(),
          ariaLabel: element.getAttribute("aria-label") ?? "",
          title: element.getAttribute("title") ?? "",
          testId: element.getAttribute("data-testid") ?? "",
        }))
        .filter((entry) => pattern.test(`${entry.text} ${entry.ariaLabel} ${entry.title}`));
    }, FORBIDDEN_ABILITY_CONTROL_TEXT.source);
    result.ability.forbiddenControls = forbiddenControls;
    await page.screenshot({ path: ABILITY_SHOT_PATH, timeout: 20_000 });

    const panelFailures = Object.entries(result.panels).filter(([, panel]) => panel.ok !== true);
    const graphEvidencePresent = graphApi.ok && graphApi.nodeCount > 0 && canvasBox !== null;
    const requiredFailures = [
      ...(panelFailures.length > 0 ? [`${panelFailures.length} 个导航面板无法打开`] : []),
      ...(result.graph.zoom.changed ? [] : ["缩放按钮没有改变缩放倍率"]),
      ...(result.graph.zoom.reset ? [] : ["重置按钮没有恢复初始缩放倍率"]),
      ...(graphEvidencePresent ? [] : ["未取得有节点的图谱画布，无法验收节点可读性和边界外平移"]),
      ...(result.graph.renderedLabels.uniqueCount > 0 ? [] : ["画布未观测到任何节点名称绘制"]),
      ...(graphEvidencePresent && pan.changed ? [] : ["拖动画布后图像未变化，无法证明边界外平移"]),
      ...(Object.values(filterPresence).every(Boolean) ? [] : ["能力筛选条未完整出现；可能尚无能力数据"]),
      ...(forbiddenControls.length === 0 ? [] : ["能力视图仍出现分类、分组或社区控制项"]),
      ...(result.unexpectedWriteRequests.length === 0 ? [] : ["验证期间检测到非 GET 请求"]),
    ];
    result.ok = requiredFailures.length === 0;
    result.requiredFailures = requiredFailures;
  } catch (error) {
    result.errors.push(shortError(error));
  } finally {
    result.finishedAt = new Date().toISOString();
    writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    // For a CDP-attached browser this releases the Playwright connection; it
    // does not own the Electron process started by run-dsh-desktop.bat.
    await browser?.close().catch(() => {});
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

await main();
