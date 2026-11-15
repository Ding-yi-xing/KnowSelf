/**
 * 人物 CRUD 的**写端口**（W-3 批次 1）。
 *
 * 面板不直接 `fetch`：与 `data-port` / `profile-port` 一致，端口由 `index.tsx` 装配注入。
 * 这样单测可以塞桩、浏览器环境可以换实现，而面板只认接口。
 *
 * ## 走哪条通道
 * 全部是写操作 → `/knowself-api/write/*` + `x-knowself-write: 1`（见 `write-bridge.ts` 的守卫）。
 * 注意 `DELETE` 也带 JSON body（`{}`）**并且带 `content-type`**：写桥对写通道统一要求
 * `application/json`，不带会被 415 拦掉——这是踩过的坑，别再"省"这个头。
 */
import type { PersonPanelRow } from "./data-port.js";
import { toQueryString } from "./query-string.js";

/** 写操作回包里可选的"图谱刷新已排队"标记（后端 `graph_refresh`）。 */
export interface GraphRefreshTicket {
  /** 是否已排队。 */
  scheduled: boolean;
  /** 后端合并窗口（毫秒）。 */
  debounce_ms: number;
}

/** W29 B1 认领回包（与后端 `201` 响应同形；字段名是 `kind` 不是 `alias_kind`）。 */
export interface PersonClaimResult {
  person_id: string;
  display_name: string;
  alias: { platform: string; kind: string; alias: string };
  graph_refresh?: GraphRefreshTicket;
}

/** 合并结果（与后端 `MergePersonsResult` 同形）。 */
export interface MergeResult {
  from: PersonPanelRow;
  to: PersonPanelRow;
  moved_aliases: number;
  dropped_duplicate_aliases: number;
}

/** 人物写端口。 */
export interface PersonWritePort {
  /** 新建人物（`POST /persons`）。 */
  createPerson(input: { display_name: string; note?: string }): Promise<PersonPanelRow>;
  /**
   * 改名 / 改备注（`PATCH /person/:id`）。
   *
   * **改名**时后端会在响应里带 `graph_refresh`（已排队重算图谱快照），
   * 前端据此显示"正在刷新图谱"——不要假设刷新已经完成。
   */
  updatePerson(
    personId: string,
    patch: { display_name?: string; note?: string },
  ): Promise<PersonPanelRow & { graph_refresh?: GraphRefreshTicket }>;
  /** 合并到目标（`POST /person/:id/merge`）；同样可能带 `graph_refresh`。 */
  mergePerson(
    personId: string,
    targetPersonId: string,
    reason?: string,
  ): Promise<MergeResult & { graph_refresh?: GraphRefreshTicket }>;
  /** 归档（`DELETE /person/:id`；语义是归档，不是物理删除）。 */
  archivePerson(personId: string): Promise<PersonPanelRow & { graph_refresh?: GraphRefreshTicket }>;
  /**
   * W29 B1：认领一个未识别的单聊/人物节点（`POST /write/person/claim`）。
   * 成功后后端已排一次图谱刷新，面板应重新取数。
   */
  claimPerson(input: { sender_ref: string; display_name: string }): Promise<PersonClaimResult>;
  /**
   * 手动重跑一次挖掘（`POST /write/mining-run`）。
   *
   * 用途：后端那次"后台刷新"失败时（例如蒸馏/挖掘抛错），用户点一下重试。
   * 后端自动刷新**不会**回推失败给前端，所以必须留这个手动出口。
   */
  runMining(): Promise<void>;
}

/** 写通道固定请求头。 */
const WRITE_HEADERS = { "content-type": "application/json", "x-knowself-write": "1" } as const;

/**
 * 同 origin REST 实现。
 *
 * @param options.baseUrl API 前缀（缺省 `/knowself-api`）
 * @returns 端口实例
 */
export function createRestPersonWritePort(options: { baseUrl?: string } = {}): PersonWritePort {
  const base = options.baseUrl ?? "/knowself-api";

  /**
   * 发一次写请求并解析 JSON。
   *
   * @param method POST / PATCH / DELETE
   * @param path 逻辑路径（不含 `/write`，由本函数补）
   * @param body 请求体
   * @returns 解析后的响应体
   * @throws Error 非 2xx；消息里带状态码与后端错误码，便于面板显示
   */
  async function send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}/write${path}`, {
      method,
      headers: WRITE_HEADERS,
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    const parsed: unknown = text === "" ? null : JSON.parse(text);
    if (!res.ok) {
      const code =
        parsed !== null && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : "unknown";
      throw new Error(`${method} ${path} → ${res.status}（${code}）`);
    }
    return parsed as T;
  }

  return {
    createPerson: (input) => send<PersonPanelRow>("POST", "/persons", input),
    updatePerson: (personId, patch) =>
      send<PersonPanelRow>("PATCH", `/person/${encodeURIComponent(personId)}`, patch),
    mergePerson: (personId, targetPersonId, reason) =>
      send<MergeResult>("POST", `/person/${encodeURIComponent(personId)}/merge`, {
        target_person_id: targetPersonId,
        ...(reason === undefined ? {} : { reason }),
      }),
    archivePerson: (personId) =>
      send<PersonPanelRow>("DELETE", `/person/${encodeURIComponent(personId)}`, {}),
    runMining: async () => {
      await send<{ snapshot_id?: string }>("POST", "/mining-run", {});
    },
    // W29 B1：复用 send（已带 /write 前缀 + x-knowself-write + 解析后端 error 码）。
    claimPerson: (input) => send<PersonClaimResult>("POST", "/person/claim", input),
  };
}

/** 目标人物搜索用的 query 串（薄封装，便于测试断言 URL 形状）。 */
export function personSearchQuery(keyword: string, limit = 8): string {
  return toQueryString([
    ["keyword", keyword],
    ["limit", String(limit)],
  ]);
}
