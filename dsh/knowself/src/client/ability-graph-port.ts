/**
 * 能力图谱面板的**只读数据端口**（T04，0.5.0）。
 *
 * ## 与别人的边界
 * 本文件只做「同源 fetch → 类型化快照」，**不含任何 UI**（面板 T05 才做），
 * 也不碰 `graph-port.ts` / `graph-canvas.ts`（人物图谱那条线由另一位负责）。
 *
 * ## 错误语义（与 `profile-port.ts` / `graph-port.ts` 完全一致，不另造一套）
 *   - `401` → {@link SessionExpiredError}：会话失效，面板提示「重新打开 dsh web」；
 *   - `503` → {@link DegradedError}：资料层未就绪（`layer="profile"`）+ reason，面板给重试；
 *   - 其它非 2xx → `Error`，消息里**必须带状态码与 body 摘要**（只写「请求失败」没法排障）。
 *
 * ## 空态
 * 0 张卡是**合法**：宿主返回 200 + 空 `nodes`/`edges`（不是因为出错），
 * 本端口原样返回快照，由面板判断 `nodes.length === 0` 显示引导文案。
 *
 * ## 缓存头
 * 宿主会回 `X-Ability-Cache: hit|miss`。端口把它挂到返回值的 `cache` 字段上，
 * 供面板/验收脚本判断「这一屏是重算的还是复用的」，不影响渲染逻辑。
 */
import type { AbilitySnapshot } from "@knowself/contracts";
import { DegradedError, SessionExpiredError, readDegradedPayload } from "./profile-port.js";

/** 端口返回：快照 + 本次是否为缓存命中（来自响应头）。 */
export interface AbilitySnapshotResponse {
  snapshot: AbilitySnapshot;
  /** `hit` = 宿主没有重算；`miss` = 本次重算（或宿主没给该头）。 */
  cache: "hit" | "miss";
}

/** 能力图谱只读端口。 */
export interface KnowselfAbilityPort {
  /**
   * 取能力快照。
   * @returns 快照 + 缓存命中状态
   * @throws SessionExpiredError 401
   * @throws DegradedError 503（资料层未就绪）
   * @throws Error 其它非 2xx（消息含状态码与 body 摘要）
   */
  getSnapshot(): Promise<AbilitySnapshotResponse>;
}

/** body 摘要最大长度（错误消息里带一小段，够定位又不刷屏）。 */
const BODY_SNIPPET_CHARS = 200;

/**
 * 把响应体收窄成一行摘要（用于错误消息）。
 * @param text 原始文本（可能为空 / 非 JSON）
 * @returns ≤200 字符的一行
 */
function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine === "") return "(empty body)";
  return oneLine.length <= BODY_SNIPPET_CHARS
    ? oneLine
    : `${oneLine.slice(0, BODY_SNIPPET_CHARS)}…`;
}

/**
 * 构造 REST 能力图谱端口。
 *
 * @param baseUrl REST 前缀，默认同 origin 相对路径 `/knowself-api`
 * @returns 只读的 {@link KnowselfAbilityPort}
 */
export function createRestAbilityPort(baseUrl = "/knowself-api"): KnowselfAbilityPort {
  return {
    getSnapshot: async (): Promise<AbilitySnapshotResponse> => {
      const url = `${baseUrl}/ability-graph`;
      // 同源请求必须带凭据（dsh web 的会话 cookie），否则 401。
      const res = await fetch(url, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });

      if (res.status === 401) {
        throw new SessionExpiredError();
      }

      // 先读文本：503 要解析降级体，非 2xx 要贴摘要，成功才 JSON.parse。
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }

      if (res.status === 503) {
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        const degraded = readDegradedPayload(body);
        if (degraded !== undefined) {
          throw new DegradedError(degraded.reason, degraded.layer);
        }
        throw new Error(`GET ${url} → 503：能力图谱数据层未就绪（${snippet(text)}`);
      }

      if (!res.ok) {
        throw new Error(`GET ${url} → ${res.status}：${snippet(text)}`);
      }

      let snapshot: AbilitySnapshot;
      try {
        snapshot = JSON.parse(text) as AbilitySnapshot;
      } catch {
        throw new Error(`GET ${url} → 200 但响应不是合法 JSON：${snippet(text)}`);
      }

      const cacheHeader = res.headers.get("X-Ability-Cache");
      return { snapshot, cache: cacheHeader === "hit" ? "hit" : "miss" };
    },
  };
}
