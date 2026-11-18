/**
 * W-9：资料面板「导入聊天记录」用的**客户端端口**。
 *
 * 拆分理由：`profile-port.ts` 是资料面板既有的只读/写资料端口，导入聊天是另一条业务链路
 * （写通道 `/write/chat-import` + 批量采纳 `/write/proposals-accept-batch`），
 * 塞进同一个接口会让既有实现的测试桩全部要跟着加方法。单独成模块，按需注入。
 *
 * 两个端点都走 handler 型写通道，必须带 `x-knowself-write: 1`。
 */

/**
 * 聊天记录**导入平台的运行时清单**（值域与顺序的唯一来源，类型由它派生）。
 *
 * 规范定义在 `packages/contracts/src/chat.ts` 的 `ChatPlatformSchema`（单一真相源）。
 * 这里保留一份**同值域镜像**，原因是当前工程链路下 client 只消费 contracts 的
 * `dist/*.d.ts`，而本次任务不重建 contracts（不跑 `tsc -b`），直接 import 新符号会读到旧
 * dist 而编译失败。
 *
 * 防漂移（两道锁）：
 *   1. 运行时断言 `test/w9-chat-import-form.test.ts`：
 *      `[...CHAT_IMPORT_PLATFORMS]` 必须逐项相等于 `[...ChatPlatformSchema.options]`；
 *   2. `sources-add-form.tsx` 的 `PLATFORM_LABELS` 是
 *      `Record<ChatImportPlatform, …>` —— 这里加值而没补文案会直接编译失败。
 * 契约改了、镜像忘改 → 立刻红。
 *
 * 注意：它不是 `AliasPlatformSchema`（别名命名空间，含 telegram/discord 等永不可导入的值）。
 */
export const CHAT_IMPORT_PLATFORMS = ["wechat", "qq", "douyin"] as const;

export type ChatImportPlatform = (typeof CHAT_IMPORT_PLATFORMS)[number];

/** 导入请求体（与 `routes/chat-import.ts` 对齐）。 */
export interface ChatImportRequest {
  /** 导出产物目录（本地路径）。与 `wechat_root` 二选一。 */
  source_path?: string;
  /** 微信 `xwechat_files` 目录：由 dsh 内部取密钥/解密/导出后再导入。 */
  wechat_root?: string;
  /**
   * @deprecated 2026-11-17 起无效：密钥改为从运行中的微信进程只读提取，
   * 不再需要退出/重启微信。保留字段仅为兼容旧调用方。
   */
  capture_key?: boolean;
  /** Reader for the official spike TXT export. */
  reader?: "txt" | "json";
  /**
   * 导出产物的来源平台（W-34-T02）。
   *
   * 缺省 `wechat`（老客户端/老请求不带该字段仍按微信解析）。服务端自带平台闸：
   * `qq` / `douyin` 会回 400 `PLATFORM_NOT_SUPPORTED`，避免被当微信解析出脏数据。
   */
  platform?: ChatImportPlatform;
  /** 是否导入后自动采纳（默认 false；true 时必须给 reason）。 */
  auto_commit?: boolean;
  /** 自动采纳的理由（进审计日志）。 */
  auto_commit_reason?: string;
}

/** 导入回包（三选回执全靠这些值；字段与 `routes/chat-import.ts` 的响应**逐字一致**）。 */
export interface ChatImportResult {
  source_id: string;
  batch_id: string;
  conversations: number;
  /**
   * 消息计数四件套（此前客户端还写着 `inserted`，与服务端已改成 parsed/committed 漂移，
   * 导致回执显示「已导入 undefined 条」——这里对齐服务端）。
   */
  messages: {
    /** 解析出的消息条数（不管有没有落库） */
    parsed: number;
    /** staging 采纳后实际落库的消息条数 */
    committed: number;
    /** 因主键冲突被跳过的条数 */
    ignored: number;
    /** 已落库但归属不到人的条数（排除 system）；0 表示全部可归因 */
    unattributed: number;
  };
  persons_created: number;
  /** 自动采纳条数（`auto_commit=false` 时为 0）。 */
  auto_committed: number;
  /** 本次导入产生的 proposal 数（0 = 没有新增/无需确认）。 */
  proposals_created?: number;
  /** 微信内建解密的摘要（只含目录、密钥来源与导出统计，不含密钥）。 */
  wechat?: {
    db_dir: string;
    key_source: "live" | "reused" | "captured";
    summary?: { newest_message_at?: string; txt_count?: number };
  };
  /** 实际落库的消息数（采纳 1 条 proposal 可能带入多条消息）。 */
  messages_committed?: number;
  snapshot_id: string | null;
  nodes: number | null;
  edges: number | null;
  mining_warning?: string;
  reply_index_sync?: {
    state: "ready" | "unavailable" | "failed";
    conversations: number;
    indexed_messages: number;
    warning?: string;
  };
}

/** 批量采纳回包。 */
export interface AcceptBatchResult {
  accepted: number;
  failed: number;
  failed_ids: string[];
}

/** 聊天导入端口。 */
export interface ChatImportPort {
  /** 导入一份本地导出目录。 */
  importChat(req: ChatImportRequest): Promise<ChatImportResult>;
  /** 采纳某条资料下所有 pending（供「全部采纳本批」使用）。 */
  acceptBatch(sourceId: string): Promise<AcceptBatchResult>;
}

const WRITE_HEADERS = { "content-type": "application/json", "x-knowself-write": "1" } as const;

/**
 * 需要用户先去登录/打开微信时抛出（服务端 409 `WECHAT_KEY_REQUIRED`）。
 *
 * 2026-11-17 起**不再**弹「重启微信抓密钥」确认框：服务端改为从运行中的微信进程
 * 只读密钥，这里只负责把可操作的中文原因显示给用户（例如「请先登录微信」）。
 */
export class WechatKeyRequiredError extends Error {
  readonly code = "WECHAT_KEY_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "WechatKeyRequiredError";
  }
}

/** 读取服务端错误体（保留 code，供面板区分可恢复错误）。 */
async function readErrorBody(res: Response): Promise<{ message: string; code?: string; phase?: string; recoverable?: boolean }> {
  let message = "";
  let code: string | undefined;
  let phase: string | undefined;
  let recoverable: boolean | undefined;
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === "object") {
      const value = body as Record<string, unknown>;
      message = typeof value.error === "string"
        ? value.error
        : typeof value.reason === "string" ? value.reason : "";
      code = typeof value.code === "string" ? value.code : undefined;
      phase = typeof value.phase === "string" ? value.phase : undefined;
      recoverable = value.recoverable === true ? true : undefined;
    }
  } catch {
    // Preserve the HTTP status when the server returned a non-JSON body.
  }
  return {
    message: message === "" ? `HTTP ${res.status}` : `HTTP ${res.status}：${message}`,
    ...(code === undefined ? {} : { code }),
    ...(phase === undefined ? {} : { phase }),
    ...(recoverable === undefined ? {} : { recoverable }),
  };
}

async function readError(res: Response, operation: string): Promise<Error> {
  const body = await readErrorBody(res);
  if (body.code === "WECHAT_KEY_REQUIRED") return new WechatKeyRequiredError(body.message);
  const code = body.code === undefined ? "" : ` [${body.code}]`;
  const phase = body.phase === undefined ? "" : `（阶段：${body.phase}）`;
  return new Error(`${operation}失败：${body.message}${code}${phase}`);
}

/**
 * 构造 REST 端口。
 * @param baseUrl REST 前缀，默认同 origin `/knowself-api`
 * @returns 聊天导入端口
 */
export function createChatImportPort(baseUrl = "/knowself-api"): ChatImportPort {
  return {
    async importChat(req: ChatImportRequest): Promise<ChatImportResult> {
      // platform 显式放在最后并给缺省值：若写成 `{ platform: "wechat", ...req }`，
      // 当 req.platform 是 undefined 时展开会把它覆盖回 undefined，JSON.stringify 又会丢掉
      // 该键 —— 结果服务端收不到字段，等于"缺省"这个约定失效。
      const payload = { ...req, reader: req.reader ?? "txt", platform: req.platform ?? "wechat" };
      const res = await fetch(`${baseUrl}/write/chat-import`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw await readError(res, "导入");
      return (await res.json()) as ChatImportResult;
    },
    async acceptBatch(sourceId: string): Promise<AcceptBatchResult> {
      const res = await fetch(`${baseUrl}/write/proposals-accept-batch`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ source_id: sourceId, reason: "ui-accept-batch" }),
      });
      if (!res.ok) throw await readError(res, "批量采纳");
      return (await res.json()) as AcceptBatchResult;
    },
  };
}

/**
 * 前端校验：只接受**本地目录**，`http(s)://` 直接拦掉。
 *
 * 为什么要拦：这是最容易误解的一处——用户看到输入框会以为能填 URL。
 * 后端只接受本地目录（reader 读文件系统），前端先给可读提示，别让请求白跑一趟。
 *
 * @param raw 用户输入
 * @returns `null` 表示通过；否则是给用户看的中文原因
 */
export function validateLocalPath(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "请填写本地目录路径";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return "仅支持本地目录，不支持网址（请填写形如 C:\\path\\to\\export 的本地路径）";
  }
  return null;
}
