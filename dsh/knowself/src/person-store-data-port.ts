/**
 * person-store 只读 API → `PersonPanelDataPort` 适配器（A2-1，宿主 / Node 侧）。
 *
 * 这是「人物面板数据取 person-store 只读 API」的**真实落地点**：
 * 三个方法逐一委托 `PersonStore.listPersons` / `getPerson` / `events.timeline`，
 * 零业务逻辑、零写操作（符合「插件层薄」技术红线）。
 *
 * 运行位置：Node / dsh 宿主进程（能加载 better-sqlite3）；**不是浏览器 bundle 的一部分**。
 * 浏览器侧面板只依赖 `PersonPanelDataPort` 接口，通过 REST / bridge 拿到同一形状的数据。
 * client↔server 桥接本身本期未实现（见 README 与 `src/client/data-port.ts` 头注）。
 */
import type { PersonListQuery, PersonRow, PersonStore } from "@knowself/person-store";
import type {
  PersonPanelDataPort,
  PersonPanelGroup,
  PersonPanelGroupMessage,
  PersonPanelMessageInteraction,
  PersonTimelineQuery,
  PersonTimelineResult,
} from "./client/data-port.js";

/**
 * 用真实 `PersonStore` 构造只读数据端口。
 * @param store 已初始化的 person-store 门面（由 `createRealServices` 装配）
 * @returns 只暴露只读查询的 `PersonPanelDataPort`
 */
export function createPersonStoreDataPort(store: PersonStore): PersonPanelDataPort {
  return {
    listPersons(q?: PersonListQuery): PersonRow[] {
      return store.listPersons(q);
    },
    getPerson(personId: string): PersonRow | null {
      return store.getPerson(personId);
    },
    timeline(
      personId: string,
      q?: PersonTimelineQuery,
    ): PersonTimelineResult {
      const events = store.events.timeline(personId, q);
      if (events.length > 0) return events;

      const limit = q?.limit ?? 20;
      const fromMs = q?.from_date === undefined ? undefined : Date.parse(`${q.from_date}T00:00:00.000Z`);
      const toMs = q?.to_date === undefined ? undefined : Date.parse(`${q.to_date}T23:59:59.999Z`);
      const total = store.messages.count({
        person_id: personId,
        conversation_kind: "direct",
        ...(Number.isNaN(fromMs) || fromMs === undefined ? {} : { from_ms: fromMs }),
        ...(Number.isNaN(toMs) || toMs === undefined ? {} : { to_ms: toMs }),
      });
      if (total === 0) return [];

      // messages.list 是时间正序；为面板提供最新优先的窗口后再反转。
      const offset = Math.max(0, total - limit);
      return store.messages.list({
        person_id: personId,
        conversation_kind: "direct",
        ...(Number.isNaN(fromMs) || fromMs === undefined ? {} : { from_ms: fromMs }),
        ...(Number.isNaN(toMs) || toMs === undefined ? {} : { to_ms: toMs }),
        limit,
        offset,
      }).reverse().map((message): PersonPanelMessageInteraction => ({
        kind: "message",
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        sender_name: message.sender_name,
        role: message.role,
        ts_ms: message.ts_ms,
        msg_date: message.msg_date,
        content: message.content,
        content_type: message.content_type,
      }));
    },
    listGroups(q?: { limit?: number }): PersonPanelGroup[] {
      return store.conversations.list({ kind: "group", limit: q?.limit ?? 100 }).map((group) => ({
        conversation_id: group.conversation_id,
        title: group.title,
        member_count: group.member_count,
        msg_count: group.msg_count,
        first_msg_at: group.first_msg_at,
        last_msg_at: group.last_msg_at,
      }));
    },
    groupTimeline(groupId: string, q?: { limit?: number }): PersonPanelGroupMessage[] {
      const limit = q?.limit ?? 50;
      const total = store.messages.count({ conversation_id: groupId });
      if (total === 0) return [];
      const offset = Math.max(0, total - limit);
      return store.messages.list({ conversation_id: groupId, limit, offset }).reverse().map((message) => ({
        kind: "message",
        message_id: message.message_id,
        conversation_id: message.conversation_id,
        sender_name: message.sender_name,
        role: message.role,
        ts_ms: message.ts_ms,
        msg_date: message.msg_date,
        content: message.content,
        content_type: message.content_type,
      }));
    },
  };
}
