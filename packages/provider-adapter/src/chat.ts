import type { ChatOptions, ChatChunk } from "@knowself/contracts";
import { parseSseStream } from "./stream";
import { transitionOnSuccess, transitionOnFailure } from "./failover";
import { codeForUpstreamStatus, isRetryableStatus } from "./errors";
import type { createRegistry } from "./registry";

export async function* chat(
  deps: {
    registry: ReturnType<typeof createRegistry>;
    fetchImpl?: typeof fetch;
  },
  opts: ChatOptions,
  signal?: AbortSignal,
): AsyncIterable<ChatChunk> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const providerId = opts.provider_id;
  const adapter = deps.registry.getAdapter(providerId);

  if (!adapter) {
    yield {
      type: "error",
      upstream_status: null,
      message: `Provider not found: ${providerId}`,
      retryable: false,
    } satisfies ChatChunk;
    return;
  }

  const semaphore = deps.registry.getSemaphore(providerId);
  const release = await semaphore.acquire(signal);

  try {
    const req = adapter.encodeRequest(opts);
    const controller = new AbortController();
    const linkedSignal = signal ? combineSignals(signal, controller.signal) : controller.signal;

    const response = await fetchImpl(req.url, {
      ...req.init,
      signal: linkedSignal,
    });

    if (!response.ok) {
      // 把上游错误体摘要带出去：只说 "HTTP 404" 会让调用方/SRE 无法区分
      // 「路径错」「模型名不存在」「鉴权失败」。截断到 300 字符避免污染日志。
      // ⚠ 必须先脱敏再进 message：这条 message 会经 ingestion 落到
      //   sources.last_error 并上屏（W-6/B）。
      const upstreamDetail = await readUpstreamErrorDetail(response);
      const msg = upstreamDetail
        ? `HTTP ${response.status}: ${upstreamDetail}`
        : `HTTP ${response.status}`;
      deps.registry.updateHealth(
        providerId,
        transitionOnFailure(
          deps.registry.getHealth(providerId)!,
          {
            // 401/403 归 AUTH_FAILED、429 归 RATE_LIMITED，其余归 UPSTREAM_5XX（W-6/C、W-7/B）
            code: codeForUpstreamStatus(response.status),
            message: msg,
            retryable: isRetryableStatus(response.status),
            provider_id: providerId,
            upstream_status: response.status,
          },
          new Date().toISOString(),
        ),
      );
      yield {
        type: "error",
        upstream_status: response.status,
        message: msg,
        // 429 也要可重试（W-7/B），不能再只按 >=500 判
        retryable: isRetryableStatus(response.status),
        retry_after_ms: readRetryAfterMs(response),
      } satisfies ChatChunk;
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        upstream_status: null,
        message: "No response body",
        retryable: true,
      } satisfies ChatChunk;
      return;
    }

    const reader = response.body.getReader();
    const sseStream = parseSseStream(reader, linkedSignal);

    const startMs = Date.now();
    for await (const chunk of adapter.decodeStream(sseStream)) {
      yield chunk;
      if (chunk.type === "message_end") {
        deps.registry.updateHealth(
          providerId,
          transitionOnSuccess(
            deps.registry.getHealth(providerId)!,
            Date.now() - startMs,
            new Date().toISOString(),
          ),
        );
      }
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      yield {
        type: "error",
        upstream_status: null,
        message: "Request aborted",
        retryable: false,
      } satisfies ChatChunk;
      return;
    }
    yield {
      type: "error",
      upstream_status: null,
      // fetch 抛错时 message 可能带完整 URL；`REDACTION_RULES` 的 G2 规则
      // 会保留参数名、把 `?api_key=…` 的值抹成 `***`（注释与实现一致，W-7/A）
      message: redactUpstreamText(err instanceof Error ? err.message : String(err)),
      retryable: true,
    } satisfies ChatChunk;
  } finally {
    try {
      release();
    } catch {
      /* already released */
    }
  }
}

/**
 * 读上游建议的重试等待时间（毫秒）。
 *
 * 支持三种写法（各家网关不一致，全部认）：
 *   - `retry-after: 1`（**秒**，RFC 7231 标准）
 *   - `retry-after: <HTTP-date>`（按当前时间差算，负数归零）
 *   - `retry-after-ms: 1200`（部分聚合平台的毫秒版）
 *
 * 解析失败/缺失一律返回 `null`，由调用方退化成指数退避。
 *
 * @param response 已判定为 !ok 的响应
 * @returns 毫秒数；无法解析时 null
 */
function readRetryAfterMs(response: Response): number | null {
  const msHeader = response.headers.get("retry-after-ms");
  if (msHeader !== null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return Math.min(Math.round(ms), 600_000);
  }

  const header = response.headers.get("retry-after");
  if (header === null) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 600_000);
  }

  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), 600_000);
}

/**
 * 读取上游错误响应体的摘要（最多 300 字符），并在**进入 message 之前**脱敏。
 *
 * 同类网关（sensenova / 各聚合平台）在 4xx 时返回形如
 * `{"error":{"message":"model is not found","type":"not_found_error"}}` 的体，
 * 丢掉它就等于丢掉唯一的定位线索。读失败/为空一律返回空串，绝不抛出。
 *
 * @param response 已判定为 !ok 的响应
 */
async function readUpstreamErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return redactUpstreamText(text.trim().slice(0, 300));
  } catch {
    return "";
  }
}

/**
 * 敏感串匹配表。
 *
 * 每项配一个替换模板：多数整段抹成 `***`；**带名字的**（URL query、表单）
 * 保留 `$1`（参数名）只抹值 —— 这样 `?api_key=***&x=1` 仍能看出是哪个参数
 * 出问题，而不是把整条 URL 变成星号堆。
 *
 * 覆盖的 5 类形状（W-7/A，G1~G5 由 QA 探针给出）：
 *   G1 `SK-REALKEY...`（大写）→ 靠 `i` 标志
 *   G2 `?api_key=abc&x=1`（URL query）→ `$1***`
 *   G3 `x-api-key: abc`（请求头）→ `x-api-key: ***`
 *   G4 `sk-abc1`（短 key）→ 下限放到 4 位
 *   G5 `api_key=abc&message=bad`（无引号表单）→ `$1=***`
 *
 * 取舍：宁可误伤（把 `sk-` 开头的正常词也抹了），也不放过真 key ——
 * 误伤的代价是日志少几个字，泄露的代价是换 key + 审计。
 */
const REDACTION_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  // G1 + G4：sk- 风格 key，大小写不敏感、下限 4 位
  { pattern: /sk-[A-Za-z0-9_-]{4,}/gi, replacement: "***" },
  // Bearer 头
  { pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: "***" },
  // W-8/A1-②：`Authorization: Basic <base64>` —— base64 里是 `user:pass` 明文，
  // 与 Bearer 同等敏感。放在 JSON 规则之前，避免被 `"authorization"` 规则抢先（会留下 Basic 原样）。
  { pattern: /Authorization(\s*:\s*)Basic\s+[A-Za-z0-9+/=._-]+/gi, replacement: "Authorization$1***" },
  // G3：x-api-key 头（冒号或等号都算）。
  // W-8/A2：值必须是**紧跟分隔符的单个 token**（分隔符后最多一个空格）。
  // 旧写法 `[:=]\s*[^\s,;}]+` 的 `\s*` 会跨过空值后的空白，把下一个字段
  // （实测 `x-api-key:  message=bad` 里的 `message=bad`）当成值吞掉，诊断信息就没了。
  {
    pattern: /x-api-key([ \t]*[:=][ \t]?)(?=[^\s,;}])[^\s,;}]+/gi,
    replacement: "x-api-key$1***",
  },
  // JSON 字段形式（带引号）
  { pattern: /"api_key"\s*:\s*"[^"]*"/gi, replacement: '"api_key":"***"' },
  { pattern: /"authorization"\s*:\s*"[^"]*"/gi, replacement: '"authorization":"***"' },
  { pattern: /"token"\s*:\s*"[^"]*"/gi, replacement: '"token":"***"' },
  { pattern: /"access_token"\s*:\s*"[^"]*"/gi, replacement: '"access_token":"***"' },
  // W-8/A1-④：JSON 键补 refresh_token / secret / camelCase accessToken
  { pattern: /"refresh_token"\s*:\s*"[^"]*"/gi, replacement: '"refresh_token":"***"' },
  { pattern: /"secret"\s*:\s*"[^"]*"/gi, replacement: '"secret":"***"' },
  { pattern: /"accessToken"\s*:\s*"[^"]*"/g, replacement: '"accessToken":"***"' },
  // W-8/A1-①：JSON 里的密码字段（password / passwd / pwd），键名原样保留
  {
    pattern: /"(password|passwd|pwd)"\s*:\s*"[^"]*"/gi,
    replacement: '"$1":"***"',
  },
  // G2：URL query —— 保留参数名，只抹值
  {
    pattern: /([?&](?:api[_-]?key|key|token|access_token|api[_-]?secret)=)[^&\s"']+/gi,
    replacement: "$1***",
  },
  // G5：无引号表单/CLI 形式 —— 保留参数名，只抹值
  {
    pattern: /(?:^|[\s,;&{])((?:api[_-]?key|token|secret|access_token))\s*=\s*[^\s,;&}]+/gi,
    replacement: " $1=***",
  },
  // W-8/A1-①：表单形式的密码（password=xxx / pwd=xxx / passwd=xxx）。
  // 用 `\b` 而不是"前导分隔符"：这样 `api_password=` 这类复合键不会被误伤，也不会往结果里塞空格。
  {
    pattern: /\b(password|passwd|pwd)\s*=\s*[^\s,;&}]+/gi,
    replacement: "$1=***",
  },
  // W-8/A1-③：**裸 `key=`**（没有 `?` / `&` 前缀）。
  // G2 只认 URL query 形式；上游把凭据摊平成 `key=abc123` 时原来漏网。
  // `\b` 保证不会切进 `api_key=` / `apikey=`（`_` 与字母之间没有词边界）。
  { pattern: /\bkey\s*=\s*[^\s,;&}]+/gi, replacement: "key=***" },
];

/**
 * 把上游返回文本里的凭据抹成 `***`。
 *
 * 为什么在 provider 侧做而不是日志层：这条文本会经 `distill.ts` →
 * `sources.last_error` → 面板上屏，属于**用户可见的落库字段**，
 * 只在日志层脱敏等于没脱。
 *
 * 只替换凭据本身，保留 `model is not found` 之类的定位信息。
 *
 * @param text 上游错误体（已截断）
 * @returns 脱敏后的文本
 */
export function redactUpstreamText(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    // 正则带 g，反复使用时需重置 lastIndex
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const handler = () => { try { ctrl.abort(a.reason ?? b.reason); } catch { /* already aborted */ } };
  a.addEventListener("abort", handler, { once: true });
  b.addEventListener("abort", handler, { once: true });
  if (a.aborted || b.aborted) ctrl.abort();
  return ctrl.signal;
}
