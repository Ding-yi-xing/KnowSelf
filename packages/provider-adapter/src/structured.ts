import { z } from "zod";
import type { ProviderMessage } from "@knowself/contracts";
import { chat } from "./chat";
import { codeForUpstreamStatus, ProviderError } from "./errors";
import type { createRegistry } from "./registry";

/** stderr 里单次记录的最大 issue 条数（防止异常输出撑爆日志）。 */
const MAX_LOGGED_ISSUES = 30;
/** 拼进 ProviderError message 的最大 issue 条数。 */
const MAX_MESSAGE_ISSUES = 5;
/** stderr 里保留的模型原始输出前缀长度。 */
const LAST_TEXT_HEAD_LEN = 500;
/** 指数退避基数（毫秒）。 */
const BACKOFF_BASE_MS = 500;
/** 单次退避上限（毫秒）。 */
const BACKOFF_CAP_MS = 8_000;

/**
 * 计算第 N 次重试前的等待时间。
 *
 * 优先级：上游给的 `retry_after_ms`（429 常见）> 指数退避
 * `min(500 * 2^attempt, 8000)`。上限 8s，避免一个坏 provider 把整条
 * 蒸馏链挂死；下限 0。
 *
 * @param attempt 当前 attempt 序号（从 0 起，代表"刚失败的那一次"）
 * @param retryAfterMs 上游建议等待毫秒；null/undefined 表示没给
 * @returns 应等待的毫秒数
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null | undefined,
): number {
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.round(retryAfterMs), BACKOFF_CAP_MS);
  }
  const exponential = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(exponential, BACKOFF_CAP_MS);
}

/** 默认 sleep 实现；测试注入桩以断言退避（不许真 sleep）。 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 一条校验失败的精简描述（路径 + 原因）。 */
export interface ValidationIssueSummary {
  /** 形如 `writes[0].excerpts`；根位置为空串。 */
  path: string;
  /** zod 原始 message。 */
  message: string;
  /** zod issue code，便于机器分类。 */
  code: string;
}

/** 单次 attempt 校验失败的取证快照。 */
interface ValidationFailureSnapshot {
  attempt: number;
  kind: "no_json" | "json" | "zod";
  errorMessage: string;
  issues: ValidationIssueSummary[];
  /** 模型本轮原始输出的前缀（最多 `LAST_TEXT_HEAD_LEN` 字符），用于事后取证。 */
  lastTextHead: string;
}

export async function requestStructured<T extends z.ZodTypeAny>(
  deps: {
    registry: ReturnType<typeof createRegistry>;
    fetchImpl?: typeof fetch;
    /**
     * 可注入的 sleep（W-7/B）。生产不传走 `setTimeout`；
     * 测试注入桩以**断言退避毫秒数**而不真等待。
     */
    sleep?: (ms: number) => Promise<void>;
  },
  req: {
    provider_id: string;
    messages: ProviderMessage[];
    schema: T;
    schemaName: string;
    maxRepairAttempts?: number;
  },
): Promise<z.infer<T>> {
  const maxAttempts = req.maxRepairAttempts ?? 1;
  const providerConfig = deps.registry.getConfig(req.provider_id);
  const timeoutMs = providerConfig?.request_timeout_ms ?? 120_000;
  const sleep = deps.sleep ?? defaultSleep;

  let lastText = "";
  let lastFailure: ValidationFailureSnapshot | null = null;
  /**
   * 最近一次**传输层/上游**失败（HTTP 4xx5xx、模型名不存在、鉴权、超时…）。
   *
   * 关键：这类失败与 schema 无关，绝不能伪装成 "validation failed"，
   * 否则排查方向会被整体带偏（W-5 就是栽在这一点上）。
   */
  let lastTransportError: ProviderError | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const msgBlocks: ProviderMessage[] = [
      ...req.messages,
      {
        role: "user",
        content: [
          {
            kind: "text" as const,
            text: `Respond ONLY with valid JSON conforming to the "${req.schemaName}" schema. No explanations.`,
          },
        ],
      },
    ];

    const abortController = new AbortController();
    const timer = setTimeout(() => {
      try { abortController.abort(); } catch { /* race */ }
    }, timeoutMs);
    const chunks: string[] = [];
    let transportFailure: ProviderError | null = null;
    /** 本次 attempt 里上游建议的重试等待毫秒（`retry-after` / `retry-after-ms`）。 */
    let retryAfterMs: number | null = null;
    try {
      try {
        for await (const chunk of chat(
          deps,
          {
            provider_id: req.provider_id,
            messages: msgBlocks,
            tools: [],
            stream: true,
            max_tokens: 4096,
            temperature: 0,
            stop_sequences: [],
            metadata: {},
          },
          abortController.signal,
        )) {
          if (chunk.type === "text") chunks.push(chunk.delta);
          if (chunk.type === "error") {
            retryAfterMs = chunk.retry_after_ms ?? null;
            throw new ProviderError(
              // 401/403 → AUTH_FAILED、429 → RATE_LIMITED，其余 → UPSTREAM_5XX（W-6/C、W-7/B）
              codeForUpstreamStatus(chunk.upstream_status),
              chunk.message,
              req.provider_id,
              chunk.upstream_status,
              chunk.retryable,
            );
          }
          if (chunk.type === "message_end") break;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // 传输失败：记录下来，不再静默丢弃。重试仅对 retryable 有意义。
      transportFailure =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              "UPSTREAM_5XX",
              err instanceof Error ? err.message : String(err),
              req.provider_id,
              null,
              true,
            );
    }

    if (transportFailure) {
      lastTransportError = transportFailure;
      reportTransportFailure(transportFailure, attempt, req);
      if (transportFailure.retryable && attempt < maxAttempts) {
        // 退避：429/5xx 时紧循环重试等于自杀（本来就撞限额），必须等一等。
        const backoffMs = computeBackoffMs(attempt, retryAfterMs);
        reportBackoff(transportFailure, attempt, backoffMs, retryAfterMs, req);
        await sleep(backoffMs);
        continue;
      }
      // 不可重试（如 404 model is not found / 401）且**没有**更可信的校验失败信息时，
      // 立即原样上报，别退化成 "validation failed"。
      // 若此前已有真实校验失败，则落到循环外，让两条原因同时出现在最终 message 里。
      if (!transportFailure.retryable && lastFailure === null) throw transportFailure;
      continue;
    }

    lastText = chunks.join("");
    const jsonText = extractJsonBlock(lastText);
    try {
      if (!jsonText) throw new SyntaxError("No JSON block found in output");
      const parsed = JSON.parse(jsonText);
      return req.schema.parse(parsed) as z.infer<T>;
    } catch (err) {
      const failure = buildFailureSnapshot(attempt, err, jsonText, lastText, req);
      lastFailure = failure;
      reportFailure(failure, req);

      if (attempt < maxAttempts) {
        // Push repair message — 带上字段级 issues，否则模型无从修正
        req.messages.push(
          {
            role: "assistant",
            content: [{ kind: "text" as const, text: lastText }],
          },
          {
            role: "user",
            content: [
              {
                kind: "text" as const,
                text: `Invalid output. Error: ${describeFailure(failure)}. Please fix and retry.`,
              },
            ],
          },
        );
      }
    }
  }

  // 全程没拿到任何模型输出 → 这是上游/配置问题，如实上报上游原因，
  // 绝不再用 "Structured output validation failed" 掩盖（W-5 的误诊根因）。
  if (lastFailure === null && lastTransportError) throw lastTransportError;

  throw new ProviderError(
    "UPSTREAM_5XX",
    `Structured output validation failed after ${maxAttempts + 1} attempts ` +
      `[schema=${req.schemaName} provider=${req.provider_id}]: ` +
      describeFailure(lastFailure) +
      (lastTransportError ? ` | also saw upstream error: ${lastTransportError.message}` : ""),
    req.provider_id,
    lastTransportError?.upstreamStatus ?? null,
    false,
  );
}

/**
 * 把任意一次校验失败整理成可落日志的快照。
 *
 * zod 的 `invalid_union` 会把候选分支包在 `unionErrors` 里，字段级信息藏在
 * 嵌套层；这里递归展开，保证最终看到的是 `writes[0].excerpts: Required`
 * 这种能直接定位的形状，而不是笼统的 `Invalid input`。
 *
 * @param attempt 当前 attempt 序号（从 0 起）
 * @param err 捕获到的异常（ZodError / SyntaxError / 其他）
 * @param jsonText 从模型输出中抽出的 JSON 片段（空串表示没抽到）
 * @param lastText 模型本轮原始输出
 * @param req 原始请求（只读 schemaName / provider_id）
 */
function buildFailureSnapshot(
  attempt: number,
  err: unknown,
  jsonText: string,
  lastText: string,
  req: { provider_id: string; schemaName: string },
): ValidationFailureSnapshot {
  void req;
  const rawIssues = extractZodIssues(err);
  const kind: ValidationFailureSnapshot["kind"] =
    rawIssues.length > 0 ? "zod" : jsonText ? "json" : "no_json";
  return {
    attempt,
    kind,
    errorMessage: err instanceof Error ? err.message : String(err),
    issues: rawIssues,
    lastTextHead: lastText.slice(0, LAST_TEXT_HEAD_LEN),
  };
}

/** 从异常里抽取（并展开）zod issues；非 zod 错误返回空数组。 */
export function extractZodIssues(err: unknown): ValidationIssueSummary[] {
  const candidate = err as { issues?: unknown; name?: unknown } | null | undefined;
  const topIssues = candidate?.issues;
  if (!Array.isArray(topIssues)) return [];

  const out: ValidationIssueSummary[] = [];
  const visit = (issues: unknown[], depth: number): void => {
    if (out.length >= MAX_LOGGED_ISSUES || depth > 6) return;
    for (const raw of issues) {
      if (out.length >= MAX_LOGGED_ISSUES) return;
      const issue = raw as {
        code?: unknown;
        path?: unknown;
        message?: unknown;
        unionErrors?: unknown;
      };
      const code = typeof issue?.code === "string" ? issue.code : "unknown";
      const path = formatIssuePath(issue?.path);

      if (code === "invalid_union") {
        out.push({ path, message: "invalid_union: 所有候选分支均不匹配", code });
        const branches = issue?.unionErrors;
        if (Array.isArray(branches)) {
          for (const branch of branches) {
            const branchIssues = (branch as { issues?: unknown })?.issues;
            if (Array.isArray(branchIssues)) visit(branchIssues, depth + 1);
          }
        }
        continue;
      }

      out.push({
        path,
        message: typeof issue?.message === "string" ? issue.message : "unknown",
        code,
      });
    }
  };

  visit(topIssues, 0);
  return out;
}

/**
 * 把 zod 的 path 数组渲染成 `writes[0].excerpts` 形式。
 *
 * @param path zod issue.path（可能是字符串/数字混合数组）
 */
function formatIssuePath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return "";
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
    } else {
      rendered += rendered === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return rendered;
}

/**
 * 生成一句人能直接读懂、且能进 `ProviderError.message` 的失败摘要。
 *
 * 最多 `MAX_MESSAGE_ISSUES` 条，超出部分折叠成 `(+N more)`。
 *
 * @param failure 失败快照；null 表示所有 attempt 都在传输层中断
 */
export function describeFailure(failure: ValidationFailureSnapshot | null): string {
  if (!failure) return "no model output captured (all attempts aborted or timed out)";
  if (failure.issues.length === 0) {
    return failure.kind === "no_json"
      ? `no JSON block found in model output (${failure.errorMessage})`
      : `invalid JSON: ${failure.errorMessage}`;
  }
  const head = failure.issues
    .slice(0, MAX_MESSAGE_ISSUES)
    .map((i) => `${i.path === "" ? "<root>" : i.path}: ${i.message}`)
    .join("; ");
  const overflow = failure.issues.length - MAX_MESSAGE_ISSUES;
  return overflow > 0 ? `${head} (+${overflow} more)` : head;
}

/**
 * 把一次校验失败写到 stderr（单行 JSON），便于事后从桌面日志/终端取证。
 *
 * @param failure 失败快照
 * @param req 原始请求
 */
function reportFailure(
  failure: ValidationFailureSnapshot,
  req: { provider_id: string; schemaName: string },
): void {
  const line = JSON.stringify({
    event: "structured_output_validation_failed",
    schema: req.schemaName,
    provider_id: req.provider_id,
    attempt: failure.attempt + 1,
    kind: failure.kind,
    error_message: failure.errorMessage,
    issue_count: failure.issues.length,
    issues: failure.issues,
    last_text_head: failure.lastTextHead,
    at: new Date().toISOString(),
  });
  try {
    console.error(`[provider-adapter][structured] ${line}`);
  } catch {
    /* stderr 不可用时静默，绝不能因为日志失败影响主流程 */
  }
}

/**
 * 记录一次退避决策到 stderr（便于事后确认「到底是它自己慢还是被限流拖慢」）。
 *
 * @param err 触发退避的传输错误
 * @param attempt 当前 attempt 序号
 * @param backoffMs 实际等待毫秒
 * @param retryAfterMs 上游建议值（null 表示走指数退避）
 * @param req 原始请求
 */
function reportBackoff(
  err: ProviderError,
  attempt: number,
  backoffMs: number,
  retryAfterMs: number | null,
  req: { provider_id: string; schemaName: string },
): void {
  const line = JSON.stringify({
    event: "structured_output_backoff",
    schema: req.schemaName,
    provider_id: req.provider_id,
    attempt: attempt + 1,
    upstream_status: err.upstreamStatus,
    code: err.code,
    retry_after_ms: retryAfterMs,
    backoff_ms: backoffMs,
    at: new Date().toISOString(),
  });
  try {
    console.error(`[provider-adapter][structured] ${line}`);
  } catch {
    /* stderr 不可用时静默 */
  }
}

/**
 * 把一次**传输层/上游**失败写到 stderr（单行 JSON）。
 *
 * 与 schema 校验失败分开记，避免二者混为一谈。
 *
 * @param err 上游 ProviderError
 * @param attempt 当前 attempt 序号（从 0 起）
 * @param req 原始请求
 */
function reportTransportFailure(
  err: ProviderError,
  attempt: number,
  req: { provider_id: string; schemaName: string },
): void {
  const line = JSON.stringify({
    event: "structured_output_transport_failed",
    schema: req.schemaName,
    provider_id: req.provider_id,
    attempt: attempt + 1,
    upstream_status: err.upstreamStatus,
    retryable: err.retryable,
    message: err.message,
    at: new Date().toISOString(),
  });
  try {
    console.error(`[provider-adapter][structured] ${line}`);
  } catch {
    /* stderr 不可用时静默 */
  }
}

/**
 * 从 LLM 输出字符串中提取 JSON 块：
 * 1. 剥离 markdown 代码围栏（```json ... ``` 或 ``` ... ```）
 * 2. 如果以 [ 开头、] 结尾 → 直接做 array 切片
 * 3. 否则取第一个 { 到最后一个 } 的子串
 * 4. 如果提取结果看似多个根对象（{...},{...}），则外包为数组
 * 5. 若找不到有效 JSON 块则返回空串
 */
function extractJsonBlock(text: string): string {
  const noFence = text.replace(/```[a-z]*\s*([\s\S]*?)\s*```/g, "$1").trim();
  if (noFence.startsWith("[") && noFence.endsWith("]")) {
    return noFence;
  }
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  const block = noFence.slice(start, end + 1);
  // If block has multiple root objects ({...},{...}) with a comma between them,
  // wrap as array preserving the comma
  const commaPos = block.indexOf("},");
  if (commaPos > 0 && block.slice(commaPos + 2).trimStart().startsWith("{")) {
    return "[" + block.slice(0, commaPos + 1) + block.slice(commaPos + 1) + "]";
  }
  return block;
}
