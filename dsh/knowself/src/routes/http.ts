/**
 * REST 路由层的**公共原语**（M3/T08 拆分产物）。
 *
 * 这里只放三件东西，全部与「鉴权」无关（鉴权闸门在 `src/web-bridge.ts` 的第一行，
 * 不得后移，因此本模块**不认识** `connection` / `requestRejection`）：
 *   ① 路由上下文与结果类型（`RouteContext` / `DispatchResult`）——路由模块之间只交换
 *      「路径 → `{ status, body }`」，不碰 `Request` / `Response`；
 *   ② 参数校验与错误类型（`BadRequestError` + `parseNonNegativeInt`）；
 *   ③ 响应与脱敏工具（`json` / `errorMessage` / `sanitizeReason` / `degradedResponse`）。
 *
 * 这些原语原先内联在 `web-bridge.ts`，拆分时**逐字迁移**并参数化（`sanitizeReason` 的
 * 兜底文案由调用方按层给出），语义不变：错误体不含堆栈 / 密钥 / 绝对路径（05 §13.4）。
 */
import type { KnowselfServices } from "../services.js";

/** 路由分发结果：状态码 + 待 JSON 序列化的响应体（由 bridge 转成 `Response`）。 */
export interface DispatchResult {
  status: number;
  body: unknown;
  /**
   * 附加响应头（加法式，可选）。
   *
   * 为什么需要：能力图谱要把缓存命中情况暴露成 `X-Ability-Cache: hit|miss`，
   * 供真机验收证明「第二次请求没有重算」。既有路由不设置该字段 → 行为逐字不变。
   */
  headers?: Readonly<Record<string, string>>;
}

/**
 * 路由上下文：bridge 解析出的最小信息面。
 *
 * `path` 是**去掉 `/knowself-api` 前缀后**的路径（`''` / `'/cards/xxx'`），路由模块只认它；
 * `url` 保留完整 URL（要读 `searchParams`）；`method` 由 bridge 透传，缺省视为 `GET`
 * （真实 `WebResource` 只回答 GET/HEAD，但单测会直调 dispatch）。
 */
export interface RouteContext {
  path: string;
  url: URL;
  services: KnowselfServices;
  method: string;
  /**
   * W-1：写端点的 JSON 请求体（已由 `web-bridge.ts` 的 handler 型通道解析并限长）。
   *
   * 保持可选：现有 263 条测试桩直调 `dispatch(url, services, method)` 时不带该字段，
   * 所有只读路由的行为必须逐字不变。`undefined` 表示「无请求体」（GET 或空 POST）。
   * 路由模块只读它、不解析原始字节、不认识鉴权——与「纯函数式分发」边界一致。
   */
  body?: unknown;
  /**
   * W-1：本次请求是否来自 `/knowself-api/write/*` 的 **handler 型写通道**。
   *
   * 存在的理由：测试桩 `routes-m3b.test.ts:256-265` 直调
   * `dispatch(url, services, "POST")` 断言「POST /sources → 404」，这是既有断言，
   * 四工单 §3.5 明确不许改。真实写请求的 URL 带 `/write` 子前缀，故用本标记
   * 区分「同一逻辑路径的两种通道」，让写路由只认 handler 型通道。
   * 缺省 `undefined`（= false），保证所有既有只读测试行为逐字不变。
   */
  writeChannel?: boolean;
}

/**
 * 单个路由模块的处理函数签名。
 *
 * 返回 `undefined` 表示「本次路径不归我管」，由 `dispatch` 继续尝试下一个模块，
 * 全部不认领 → 404（未知路径语义与拆分前完全一致）。
 * 允许返回 Promise：人物层端口签名是 `T | Promise<T>`（本地适配器同步、未来 bridge 异步），
 * `dispatch` 统一 `await`，调用方无需关心。
 */
export type RouteHandler = (
  ctx: RouteContext,
) => DispatchResult | undefined | Promise<DispatchResult | undefined>;

/** 参数校验失败：由 bridge 的 catch 统一转成 400 + {error}。 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** 统一 JSON 响应（content-type: application/json）。 */
export function json(data: unknown, status = 200, extraHeaders?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}

/** 从 unknown 取可读的错误消息（供 500 响应体与日志）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 脱敏：去掉绝对路径 / UNC 路径 / 长 base64（可能是密钥）/ 堆栈换行，
 * 压成单行并限长。用于 503 的 reason 与 500 的 error（05 §13.4 要求不含
 * 堆栈、密钥、绝对路径）。短桩错误如 `boom-store` 原样保留，既有断言零回退。
 *
 * @param raw 原始错误消息
 * @param fallback 脱敏后为空时的兜底文案（按层给出，如「人物层未就绪」）
 */
export function sanitizeReason(raw: string, fallback = "未就绪"): string {
  let text = raw;
  text = text.replace(/\\\\\?\\[^\s"'`)]+/g, "[路径已省略]");
  text = text.replace(/[A-Za-z]:\\[^\s"'`)]+/g, "[路径已省略]");
  text = text.replace(/(?:^|\s)\/(?:[\w.-]+\/){2,}[\w.-]+/g, " [路径已省略]");
  text = text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[已省略]");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 300) || fallback;
}

/**
 * 503 降级响应体（与客户端 `DegradedPayload` 约定一致）。
 * @param reason 已脱敏的可读原因
 * @param layer 降级层标识（人物层 `"person"`；核心层正常情况下不会降级）
 */
export function degradedBody(reason: string, layer: string): DispatchResult {
  return { status: 503, body: { status: "degraded", reason, layer } };
}

/**
 * 解析非负整数 query 参数；未提供 → undefined，非法（非数字 / 小数 / 负数 / 空串）→ 400。
 * limit / offset / min_importance 统一用此校验（`B2-工单.md` §1「参数错误 400」）。
 */
export function parseNonNegativeInt(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  if (raw.trim() === "") throw new BadRequestError(`参数 ${name} 不能为空`);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`参数 ${name} 必须是非负整数：${raw}`);
  }
  return value;
}

/**
 * 解码路径中的动态片段（人物 id / 卡片 key / 日志日期）。
 * 缺失 / 非法百分号编码 → 400（与拆分前 `decodePersonId` 行为一致）。
 * @param raw 原始（未解码）路径片段
 * @param label 报错里的中文名（如「人物 id」）
 */
export function decodePathSegment(raw: string | undefined, label: string): string {
  if (raw === undefined) throw new BadRequestError(`${label} 缺失`);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BadRequestError(`${label} 编码非法：${raw}`);
  }
}
