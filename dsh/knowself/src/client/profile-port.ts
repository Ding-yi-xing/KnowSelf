/**
 * 画像 / 日志面板的数据端口（M3，与 `data-port.ts` 的 `PersonPanelDataPort` 同风格）。
 *
 * ## 为什么单独一个端口
 * 画像（L1 core + L2 cards）与日志（L3 journal）都来自**核心层** `profileStore`，
 * 而人物档案来自**人物层** `personStore`——两层的降级语义不同：
 *   - 人物层可缺 → 503 `{layer:"person"}`；
 *   - 核心层必有 → 缺了就是装配异常（500）。
 * 把端口拆开，面板不必知道「哪一层会降级」，错误语义由端口统一翻译。
 *
 * ## 错误语义（三种必须可区分，05 §14 共同约束 4）
 *   - `401` → {@link SessionExpiredError}：面板显示「会话已失效，请重新打开 dsh web」；
 *   - `503` → {@link DegradedError}：面板显示「数据层未就绪：<reason>」+ 重试按钮；
 *   - 其它非 2xx → 普通 `Error`（`<METHOD> <url> → <status>`）：通用错误态。
 *
 * 与宿主侧 `src/routes/*.ts` 注册的端点一一对齐（同 origin 相对路径）：
 *   getProfileCore   → GET {base}/profile/core
 *   listCards        → GET {base}/cards[?layer=L2]（L1 不是卡片层，宿主对 layer=L1 回 400）
 *   getCard          → GET {base}/cards/{key}
 *   listJournalDates → GET {base}/journal
 *   getJournal       → GET {base}/journal/{date}
 *   listProposals    → GET {base}/proposals[?status=pending|accepted|edited|rejected]
 *   listSources      → GET {base}/sources[?limit=&offset=&status=]
 *
 * ## W-1：两个写方法（唯一例外的前缀）
 * 官方 webserver 的 **resource 型路由只放行 GET/HEAD**，非 GET 在宿主层直接 405、
 * 请求体根本不进 dispatch。因此写端点由服务端并列注册 **handler 型路由**，物理前缀是
 * `{base}/write`。本端口只对两个写方法加该前缀；现有 7 个 GET 方法继续用 `{base} + path`，
 * 统一加前缀会让全部只读请求失效。
 *
 *   createSource → POST {base}/write/sources
 *   runDistill   → POST {base}/write/sources/{id}/distill
 *
 * 只依赖标准 Fetch API 与浏览器全局对象，零 npm 依赖；返回类型全部复用
 * `@knowself/contracts` 的导出类型（单一真相源；`import type` 编译期擦除，
 * 浏览器 bundle 不引入领域库运行时）。
 */
import type {
  CardInput,
  CardSummary,
  CardWithSections,
  CoreProfileInput,
  CoreProfileStored,
  CreateSourceInput,
  IngestionProposal,
  JournalDateSummary,
  JournalEntryStored,
  ProposalStatus,
  SourceStatus,
  SourceStored,
} from "@knowself/contracts";
import { toQueryString } from "./query-string.js";

/**
 * 卡片层标识。
 * M3 波 2 起只有 `L2`：L1 不是卡片层（`core_profile` 单行，由 `/profile/core` 提供），
 * 宿主对 `?layer=L1` 明确回 400 `unsupported_layer`，因此端口层面不再保留 L1 取值，
 * 让「L1 走哪个端点」在类型上就只有一个答案。
 */
export type KnowselfCardLayer = "L2";

/**
 * 资料列表查询（与宿主 `GET /sources?limit=&offset=&status=` 对齐）。
 * 三个字段都可省略：宿主按 `limit=50 / offset=0` 缺省，`status` 缺省表示不过滤。
 */
export interface KnowselfSourceListQuery {
  /** 资料处理状态过滤（六选一），省略表示不过滤。 */
  status?: SourceStatus;
  /** 分页上限（非负整数）。 */
  limit?: number;
  /** 分页偏移（非负整数）。 */
  offset?: number;
}

/** 重新蒸馏的返回形状（服务端收敛后的最小投影）。 */
export interface RunDistillResult {
  source_id: string;
  proposal_count: number;
}

/**
 * 画像 / 日志 / 待整理 / 资料数据端口。
 * 全异步：浏览器侧只能走 fetch（领域库是 Node 原生模块，浏览器直连不了）。
 */
export interface KnowselfProfilePort {
  /** 读取 L1 核心画像（`profileStore.core.get()`）。 */
  getProfileCore(): Promise<CoreProfileStored>;
  /** 列出 L2 卡片摘要；`layer` 省略表示全部（宿主对 `L1` 返回 400，本端口不传 L1）。 */
  listCards(layer?: KnowselfCardLayer): Promise<CardSummary[]>;
  /** 读取单张卡片（含 sections）。 */
  getCard(key: string): Promise<CardWithSections>;
  /** 保存核心画像（`PATCH /write/profile/core`）。 */
  saveProfileCore(input: CoreProfileInput): Promise<CoreProfileStored>;
  /** 创建一张 L2 主题卡片（`POST /write/cards`）。 */
  createCard(input: CardInput): Promise<CardWithSections>;
  /** 保存既有主题卡片（`PATCH /write/cards/:key`）。 */
  saveCard(key: string, input: CardInput): Promise<CardWithSections>;
  /** 删除既有主题卡片（`DELETE /write/cards/:key`）。 */
  deleteCard(key: string): Promise<{ key: string; deleted: boolean }>;
  /** 列出有日志的日期（宿主已按日期倒序返回）。 */
  listJournalDates(): Promise<JournalDateSummary[]>;
  /** 读取某一天的日志记录（无数据时 `records: []`，不是错误）。 */
  getJournal(date: string): Promise<JournalEntryStored>;
  /**
   * 列出摄入提案（待整理收件箱）。`status` 省略 = 宿主缺省的 `pending`。
   * 宿主已按 `created_at DESC` 返回。
   */
  listProposals(status?: ProposalStatus): Promise<IngestionProposal[]>;
  /** 列出资料（`profileStore.sources.list()`）；宿主只返回数组（不含 total）。 */
  listSources(query?: KnowselfSourceListQuery): Promise<SourceStored[]>;
  /** W-1：新建资料（线上传输 DTO → 服务端映射成领域入参）。 */
  createSource(input: CreateSourceInput): Promise<SourceStored>;
  /** W-1：对已有资料重新蒸馏。 */
  runDistill(sourceId: string): Promise<RunDistillResult>;
  /**
   * W-3：资料改名（`PATCH /write/source/:id`）。只改展示名，不动内容与蒸馏结果。
   * @param sourceId 资料 id
   * @param name 新名字（去空白后非空由服务端再校验一次）
   */
  renameSource(sourceId: string, name: string): Promise<SourceStored>;
  /**
   * W-3：删除资料（`DELETE /write/source/:id`）。
   *
   * 服务端是**物理删除**（sources 表无归档态），若该资料已产出过已采纳提案会返回 409；
   * `force=true` 时才连带删除（会级联清掉它的 proposals / profile_sources 关联）。
   *
   * @param sourceId 资料 id
   * @param force 是否强制（默认 false）
   */
  deleteSource(sourceId: string, force?: boolean): Promise<{ id: string; deleted: boolean }>;
  /**
   * 采纳一条 `pending` 提案（`POST {base}/write/proposal/:id/accept`）。
   *
   * 落档逻辑在服务端 `@knowself/ingestion.acceptProposal`（本端口只做接线，不重写）。
   * 采纳后该提案离开 pending（列表刷新即消失）。
   */
  acceptProposal(proposalId: string): Promise<IngestionProposal>;
  /**
   * 拒绝一条 `pending` 提案（`POST {base}/write/proposal/:id/reject`）。
   *
   * 同样只做接线：服务端 `@knowself/ingestion.rejectProposal` 负责真正的状态迁移。
   */
  rejectProposal(proposalId: string): Promise<IngestionProposal>;
}

/** 会话失效（401）：需要重新打开 dsh web 拿新会话。 */
export class SessionExpiredError extends Error {
  readonly status = 401 as const;

  constructor() {
    super("会话已失效，请重新打开 dsh web");
    this.name = "SessionExpiredError";
  }
}

/**
 * 数据层降级（503）：面板显示「数据层未就绪：<reason>」+ 重试按钮。
 * `layer` 缺省时视为未知层（宿主契约里一定有，但客户端不假设）。
 */
export class DegradedError extends Error {
  readonly status = "degraded" as const;
  readonly reason: string;
  readonly layer: string;

  constructor(reason: string, layer = "unknown") {
    super(`数据层未就绪：${reason}`);
    this.name = "DegradedError";
    this.reason = reason;
    this.layer = layer;
  }
}

/** 503 降级体形状（与宿主 §13.4 约定一致；核心层端点若降级也走同一体）。 */
interface DegradedPayloadLike {
  status: "degraded";
  reason: string;
  layer: string;
}

/**
 * 类型守卫：只认宿主约定的降级体。
 * `layer` 缺失时补 `"unknown"`，避免把「结构合法但字段不全」的响应误判成通用错误。
 *
 * M3 波 3 起导出：图谱端口（`graph-port.ts`）复用同一份判定，避免两处实现漂移
 * （「503 但响应体不是降级体」必须**一致地**退化成通用 Error）。
 */
export function readDegradedPayload(value: unknown): DegradedPayloadLike | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== "degraded" || typeof record.reason !== "string") return undefined;
  const layer = typeof record.layer === "string" ? record.layer : "unknown";
  return { status: "degraded", reason: record.reason, layer };
}

/**
 * 拼 query string：跳过 `undefined` 值，键值都做 `encodeURIComponent`。
 * M3 波 3 起实现移到 `query-string.ts`（图谱端口共用同一规则，避免两处漂移），
 * 这里保留同名导出以免调用方（含测试）行为变化。
 */
export { toQueryString };

/**
 * 构造 REST 画像/日志/待整理/资料端口。
 * @param baseUrl REST 前缀，默认同 origin 相对路径 `/knowself-api`
 * @returns {@link KnowselfProfilePort}（7 个只读方法 + 2 个写方法）
 */
export function createRestProfilePort(baseUrl = "/knowself-api"): KnowselfProfilePort {
  /** 每次写调用新生成一个幂等键（只用浏览器全局对象，不引入任何宿主侧 API）。 */
  const newIdempotencyKey = (): string =>
    `ks-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  /**
   * 统一请求 + 错误翻译（401 / 503 / 其它非 2xx）。
   * GET 保持既有形态：`fetch(url, { headers: { accept } })`，不显式带 method，
   * 也不加 `/write` 前缀；只有 POST 才走 handler 型前缀并带写守卫请求头。
   */
  const request = async <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: unknown,
  ): Promise<T> => {
    const isWrite = method !== "GET";
    const url = isWrite ? `${baseUrl}/write${path}` : `${baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    let init: RequestInit = { headers };
    if (isWrite) {
      headers["content-type"] = "application/json";
      headers["x-knowself-write"] = "1";
      // 只有 POST 走幂等键：PATCH/DELETE 的语义是「以最后一次为准」，重放缓存反而会吞掉用户改了两次
      if (method === "POST") headers["x-knowself-idempotency-key"] = newIdempotencyKey();
      init = { method, headers, body: JSON.stringify(payload ?? {}) };
    }
    const res = await fetch(url, init);
    if (res.status === 401) {
      throw new SessionExpiredError();
    }
    if (res.status === 503) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const degraded = readDegradedPayload(body);
      if (degraded !== undefined) {
        throw new DegradedError(degraded.reason, degraded.layer);
      }
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
    return (await res.json()) as T;
  };

  const get = <T>(path: string): Promise<T> => request<T>("GET", path);
  const post = <T>(path: string, payload: unknown): Promise<T> =>
    request<T>("POST", path, payload);

  return {
    getProfileCore: (): Promise<CoreProfileStored> => get<CoreProfileStored>("/profile/core"),
    listCards: (layer?: KnowselfCardLayer): Promise<CardSummary[]> =>
      get<CardSummary[]>(layer === undefined ? "/cards" : `/cards?layer=${layer}`),
    getCard: (key: string): Promise<CardWithSections> =>
      get<CardWithSections>(`/cards/${encodeURIComponent(key)}`),
    saveProfileCore: (input: CoreProfileInput): Promise<CoreProfileStored> =>
      request<CoreProfileStored>("PATCH", "/profile/core", input),
    createCard: (input: CardInput): Promise<CardWithSections> =>
      post<CardWithSections>("/cards", input),
    saveCard: (key: string, input: CardInput): Promise<CardWithSections> =>
      request<CardWithSections>("PATCH", `/cards/${encodeURIComponent(key)}`, input),
    deleteCard: (key: string): Promise<{ key: string; deleted: boolean }> =>
      request<{ key: string; deleted: boolean }>("DELETE", `/cards/${encodeURIComponent(key)}`, {}),
    listJournalDates: (): Promise<JournalDateSummary[]> =>
      get<JournalDateSummary[]>("/journal"),
    getJournal: (date: string): Promise<JournalEntryStored> =>
      get<JournalEntryStored>(`/journal/${encodeURIComponent(date)}`),
    listProposals: (status?: ProposalStatus): Promise<IngestionProposal[]> =>
      get<IngestionProposal[]>(`/proposals${toQueryString([["status", status]])}`),
    listSources: (query?: KnowselfSourceListQuery): Promise<SourceStored[]> =>
      get<SourceStored[]>(
        `/sources${toQueryString([
          ["status", query?.status],
          ["limit", query?.limit === undefined ? undefined : String(query.limit)],
          ["offset", query?.offset === undefined ? undefined : String(query.offset)],
        ])}`,
      ),
    createSource: (input: CreateSourceInput): Promise<SourceStored> =>
      post<SourceStored>("/sources", input),
    runDistill: (sourceId: string): Promise<RunDistillResult> =>
      post<RunDistillResult>(`/sources/${encodeURIComponent(sourceId)}/distill`, {}),
    renameSource: (sourceId: string, name: string): Promise<SourceStored> =>
      request<SourceStored>("PATCH", `/source/${encodeURIComponent(sourceId)}`, { name }),
    deleteSource: (
      sourceId: string,
      force = false,
    ): Promise<{ id: string; deleted: boolean }> =>
      request<{ id: string; deleted: boolean }>(
        "DELETE",
        `/source/${encodeURIComponent(sourceId)}${force ? "?force=1" : ""}`,
        {},
      ),
    acceptProposal: (proposalId: string): Promise<IngestionProposal> =>
      post<IngestionProposal>(`/proposal/${encodeURIComponent(proposalId)}/accept`, {}),
    rejectProposal: (proposalId: string): Promise<IngestionProposal> =>
      post<IngestionProposal>(`/proposal/${encodeURIComponent(proposalId)}/reject`, {}),
  };
}
