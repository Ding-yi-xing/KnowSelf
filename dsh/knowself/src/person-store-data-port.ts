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
      return store.events.timeline(personId, q);
    },
  };
}
