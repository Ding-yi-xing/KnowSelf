/**
 * 人物面板只读数据端口（A2-1）——浏览器 / 宿主之间的解耦契约。
 *
 * ## 为什么需要端口（如实说明架构约束）
 * 用户拍板「数据取 person-store 只读 API」，但 client 面板运行在**浏览器**里，
 * 而 `@knowself/person-store` 底层是 better-sqlite3（Node 原生模块），浏览器无法直连。
 * 因此：
 *   - 这里定义一个**只读端口** `PersonPanelDataPort`，方法形状对齐 `PersonStore` 的
 *     `listPersons` / `getPerson` / `events.timeline`，返回类型全部复用领域库导出类型
 *     （单一真相源，零重复定义）；
 *   - 面板 React 组件只依赖该端口（props 注入），**不 import person-store 运行时实现**；
 *   - 宿主 / Node 侧的 `createPersonStoreDataPort`（`src/person-store-data-port.ts`）
 *     确实调用 person-store 只读 API，是端口的真实实现，满足「数据取 person-store 只读 API」；
 *   - **client↔server 桥接（REST / dsh 官方通信）本期未接通**，见 README「A2 面板实现」。
 *     默认端口为 `UNAVAILABLE_PORT`（返回空数据），UI 会明确提示「数据桥接待接入」，
 *     不假装浏览器能直连 SQLite。
 *
 * 方法返回 `T | Promise<T>`：`PersonStore` 的只读 API 是同步的，本地适配器可原样透传；
 * 未来的 REST / bridge 端口必然异步，面板组件统一用 `await Promise.resolve(...)` 消费。
 */
import type { PersonListQuery, PersonRow, PersonStore } from "@knowself/person-store";

/**
 * 事件时间线查询条件 —— 从 `EventsRepo.timeline` 的**真实签名**提取，零重复定义。
 * `events.timeline` 的第二个参数是内联匿名对象类型，领域库未导出命名类型。
 */
export type PersonTimelineQuery = NonNullable<
  Parameters<PersonStore["events"]["timeline"]>[1]
>;

/** 事件时间线返回行（`EventRow[]` 的元素类型，由领域库签名推导）。 */
export type PersonPanelEvent = ReturnType<PersonStore["events"]["timeline"]>[number];

/** 没有挖掘事件时用于最近互动的原始聊天消息投影。 */
export interface PersonPanelMessageInteraction {
  kind: "message";
  message_id: string;
  conversation_id: string;
  sender_name: string;
  role: "me" | "other" | "system";
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: string;
}

/** 最近互动：优先关系事件，缺失时回退为明确标识的原始消息。 */
export type PersonTimelineResult = Array<PersonPanelEvent | PersonPanelMessageInteraction>;

/** 面板展示的人物行（复用领域库导出类型，不重复定义）。 */
export type PersonPanelRow = PersonRow;

/** 群聊列表行（只取面板需要的真实字段）。 */
export interface PersonPanelGroup {
  conversation_id: string;
  title: string;
  member_count: number;
  msg_count: number;
  first_msg_at: string | null;
  last_msg_at: string | null;
}

/** 群消息行（与人物时间线的消息形态一致）。 */
export interface PersonPanelGroupMessage {
  kind: "message";
  message_id: string;
  conversation_id: string;
  sender_name: string;
  role: "me" | "other" | "system";
  ts_ms: number;
  msg_date: string;
  content: string;
  content_type: string;
}

/**
 * 人物面板只读数据端口。
 * 只读、无写方法；实现方可以是本地 person-store 适配器，也可以是未来的 REST 客户端。
 */
export interface PersonPanelDataPort {
  /** 对齐 `PersonStore.listPersons(q?)`。 */
  listPersons(q?: PersonListQuery): PersonRow[] | Promise<PersonRow[]>;
  /** 对齐 `PersonStore.getPerson(id)`。 */
  getPerson(personId: string): PersonRow | null | Promise<PersonRow | null>;
  /** 对齐 `PersonStore.events.timeline(id, q?)`。 */
  timeline(
    personId: string,
    q?: PersonTimelineQuery,
  ): PersonTimelineResult | Promise<PersonTimelineResult>;
  /** 群聊目录（按最近消息倒序）。 */
  listGroups?(q?: { limit?: number }): PersonPanelGroup[] | Promise<PersonPanelGroup[]>;
  /** 群消息（最新优先）。 */
  groupTimeline?(
    groupId: string,
    q?: { limit?: number },
  ): PersonPanelGroupMessage[] | Promise<PersonPanelGroupMessage[]>;
}

/**
 * 桥接未配置时的默认端口：返回空数据，让面板可渲染但诚实反映「无数据通道」。
 * 不抛错、不伪装数据。
 */
export const UNAVAILABLE_PORT: PersonPanelDataPort = {
  listPersons: () => [],
  getPerson: () => null,
  timeline: () => [],
  listGroups: () => [],
  groupTimeline: () => [],
};

let activePort: PersonPanelDataPort | undefined;
let bridgeConfigured = false;

/**
 * 注册端口（供宿主装配或未来 REST/bridge 实现调用）。
 * 传 `undefined` 可重置为未配置状态。
 */
export function setPersonPanelDataPort(port: PersonPanelDataPort | undefined): void {
  activePort = port;
  bridgeConfigured = port !== undefined;
}

/** 当前端口：未配置时返回 `UNAVAILABLE_PORT`。 */
export function getPersonPanelDataPort(): PersonPanelDataPort {
  return activePort ?? UNAVAILABLE_PORT;
}

/** 数据桥接是否已配置（供面板显示诚实提示）。 */
export function isPersonPanelBridgeConfigured(): boolean {
  return bridgeConfigured;
}
