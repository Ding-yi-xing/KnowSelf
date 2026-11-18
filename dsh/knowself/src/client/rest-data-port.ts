/**
 * 浏览器侧 REST 数据端口（B2，方案 A）—— `PersonPanelDataPort` 的 fetch 实现。
 *
 * 与宿主侧 `src/web-bridge.ts` 注册的 `/knowself-api` 只读端点对齐（同 origin 相对路径）：
 *   listPersons → GET {base}/persons?...
 *   getPerson   → GET {base}/person/{encodeURIComponent(id)}
 *   timeline    → GET {base}/person/{encodeURIComponent(id)}/timeline?...
 *
 * 只依赖标准 Fetch API 与 `URLSearchParams`，零 npm 依赖；返回类型全部复用
 * `@knowself/person-store` 导出类型与 `data-port.ts` 推导类型（单一真相源、零重复定义）。
 *
 * §13.4：宿主在**人物层降级**时返回 503 + `{ status:"degraded", reason, layer:"person" }`。
 * 本端口把它解析成专用的 `PersonLayerDegradedError`（携带可读 reason），让面板显示
 * 「数据层未就绪：<reason>」+ 重试按钮；其它非 2xx 仍走既有通用错误态
 * （`GET <url> → <status>`），消息格式零回退。
 *
 * 注：`getPerson` 未找到时宿主返回 200 + `null`，这里直接 `res.json()` 得 `null`，
 * 与 `PersonPanelDataPort.getPerson: PersonRow | null` 天然对齐（B2-工单.md §1 二选一）。
 */
import type { PersonListQuery, PersonRow } from "@knowself/person-store";
import type {
  PersonPanelDataPort,
  PersonPanelGroup,
  PersonPanelGroupMessage,
  PersonTimelineQuery,
  PersonTimelineResult,
} from "./data-port.js";

/** 503 人物层降级的响应体形状（与宿主 §13.4 约定一致）。 */
export interface DegradedPayload {
  status: "degraded";
  reason: string;
  layer: "person";
}

/** 类型守卫：只认宿主约定的降级体，其它 503 一律按通用错误处理。 */
function isDegradedPayload(value: unknown): value is DegradedPayload {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === "degraded" &&
    record.layer === "person" &&
    typeof record.reason === "string"
  );
}

/**
 * 人物层降级专用错误。面板据此显示「数据层未就绪」+ 重试按钮，
 * 与「桥没注册（404）」「领域异常（500）」明确区分。
 */
export class PersonLayerDegradedError extends Error {
  readonly status = "degraded" as const;
  readonly layer = "person" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(`数据层未就绪：${reason}`);
    this.name = "PersonLayerDegradedError";
    this.reason = reason;
  }
}

/**
 * 构造 REST 数据端口。
 * @param baseUrl REST 前缀，默认同 origin 相对路径 `/knowself-api`
 * @returns 只读的 `PersonPanelDataPort`（三方法均为异步）
 */
export function createRestDataPort(baseUrl = "/knowself-api"): PersonPanelDataPort {
  /** 统一的 GET + JSON 解析；非 2xx 抛错（错误消息含完整请求 URL，便于诊断）。 */
  const get = async <T>(path: string): Promise<T> => {
    const url = baseUrl + path;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (res.status === 503) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (isDegradedPayload(body)) {
        throw new PersonLayerDegradedError(body.reason);
      }
    }
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return (await res.json()) as T;
  };

  /** 把 query 对象拼成 URLSearchParams 字符串（跳过 undefined / null，exactOptional 友好）。 */
  const qs = (q: object | undefined): string => {
    if (q === undefined) return "";
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(q)) {
      if (value !== undefined && value !== null) sp.set(key, String(value));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
  };

  return {
    listPersons: (q?: PersonListQuery): Promise<PersonRow[]> =>
      get<PersonRow[]>(`/persons${qs(q)}`),
    getPerson: (personId: string): Promise<PersonRow | null> =>
      get<PersonRow | null>(`/person/${encodeURIComponent(personId)}`),
    timeline: (
      personId: string,
      q?: PersonTimelineQuery,
    ): Promise<PersonTimelineResult> =>
      get<PersonTimelineResult>(
        `/person/${encodeURIComponent(personId)}/timeline${qs(q)}`,
      ),
    listGroups: (q?: { limit?: number }): Promise<PersonPanelGroup[]> =>
      get<PersonPanelGroup[]>(`/groups${qs(q)}`),
    groupTimeline: (
      groupId: string,
      q?: { limit?: number },
    ): Promise<PersonPanelGroupMessage[]> =>
      get<PersonPanelGroupMessage[]>(
        `/group/${encodeURIComponent(groupId)}/timeline${qs(q)}`,
      ),
  };
}
