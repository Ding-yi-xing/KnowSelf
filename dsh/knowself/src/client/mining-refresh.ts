/**
 * 「挖掘状态变了，请刷新」的**显式信号**（W-9）。
 *
 * ## 为什么不用隐式刷新
 * 资料面板采纳/导入成功后，用户还停在资料面板；此时图谱并不在渲染。若让图谱面板
 * "切回时自己想起来重拉"，一旦有人改动了挂载/可见性逻辑就会静默失效——**回执说
 * 「正在生成关系图」，而图谱永远是旧的**。所以用一个显式信号：谁改了数据谁 bump，
 * 关心数据的面板订阅。
 *
 * ## 语义
 * - `bumpMiningRefresh()`：数据变了（导入 / 批量采纳 成功）。
 * - `subscribeMiningRefresh(fn)`：订阅者收到通知后自己决定怎么刷（图谱面板就是
 *   `reloadToken++`，从而重拉 `graph` + `mining/status`）。
 * - `getMiningRefreshToken()`：当前计数（调试/测试用；面板不需要读它）。
 *
 * 只做信号，不做数据获取——保持"谁拥有数据谁负责拉"的边界。
 */

let token = 0;
const listeners = new Set<() => void>();

/**
 * 通知所有订阅者「挖掘数据可能变了」。
 */
export function bumpMiningRefresh(): void {
  token += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响其它订阅者 */
    }
  }
}

/**
 * 订阅刷新信号。
 *
 * @param listener 回调
 * @returns 取消订阅函数
 */
export function subscribeMiningRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 当前信号计数（仅测试/调试用）。
 * @returns 自进程启动以来 bump 的次数
 */
export function getMiningRefreshToken(): number {
  return token;
}

/** 复位（仅测试用）。 */
export function resetMiningRefreshForTest(): void {
  token = 0;
  listeners.clear();
}
