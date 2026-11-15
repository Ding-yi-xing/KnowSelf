/**
 * **跨面板跳转 handoff**（图谱 → 人物档案，W-2）。
 *
 * ## 为什么需要它
 * `GraphPanelView` 只接 `port` 一个 prop，拿不到 `ctx.layout.selectPanel`；
 * `PersonPanelView` 的 `selectedId` 是组件内部 state，外部无法设置。
 * 而两个面板都由 `ctx.slots.register` 注册，可能是**持续挂载**的（切面板不卸载）。
 *
 * 所以拆成两半：
 *   ① 图谱侧点击节点 → `focusPerson(personId)`（只投递，不关心谁接）；
 *   ② 人物面板侧订阅 → 收到 id 就 `setSelectedId(id)`。
 *
 * ## 为什么不用全局状态库
 * 只有「一次性投递一个 id」这一个需求，引入 store 属于过度设计，还会把
 * 「面板切走后状态要不要清」变成新的状态机问题。
 *
 * ## 两种投递路径（这一段是本模块的核心）
 *   - **已挂载的消费者**：`focusPerson` 直接同步通知所有订阅者，**并且不再留存**；
 *   - **尚未挂载的消费者**：没有订阅者时把 id 存进 `pending`，等人物面板挂载后
 *     `consumeFocusedPerson()` 读走（一次性，读后即清）。
 *
 * 两条路径互斥，因此不会出现「同一次点击被消费两次」。
 */

/** 待投递的人物 id（未挂载消费者时才留存）。 */
let pendingPersonId: string | null = null;

/** 当前订阅者（人物面板挂载期间存在）。 */
const listeners = new Set<(personId: string) => void>();

/**
 * 请求把人物面板切到某个人物。
 *
 * @param personId 目标人物 id（空串视为无效，直接忽略）
 */
export function focusPerson(personId: string): void {
  if (personId === "") return;
  if (listeners.size > 0) {
    // 已挂载：同步通知，且**不**留存（避免下一次挂载重复消费同一次点击）
    for (const listener of listeners) listener(personId);
    pendingPersonId = null;
    return;
  }
  pendingPersonId = personId;
}

/**
 * 读走待投递的人物 id（一次性）。
 *
 * @returns 人物 id；没有待投递目标时返回 `null`
 */
export function consumeFocusedPerson(): string | null {
  const value = pendingPersonId;
  pendingPersonId = null;
  return value;
}

/**
 * 订阅「切换到某人物」事件（人物面板挂载时调用）。
 *
 * @param listener 回调；收到 id 后由调用方决定怎么选中
 * @returns 取消订阅函数（组件卸载时调用）
 */
export function subscribeFocusedPerson(listener: (personId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 清空待投递目标与订阅者（**仅供测试**在用例之间复位模块级状态）。
 */
export function resetPanelJumpForTest(): void {
  pendingPersonId = null;
  listeners.clear();
}
