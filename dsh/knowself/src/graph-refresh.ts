/**
 * 图谱快照的**自动刷新调度**（批次 1 缺陷 2 的修复）。
 *
 * ## 问题
 * `GET /graph` 读的是**挖掘快照**（`graph_snapshots`），节点 label 是挖掘那一刻写死的。
 * 用户在人物档案里改名 → `persons.display_name` 变了，但快照里的 label 没变 →
 * 切到图谱还是旧名字。用户会认为"改名没生效"——这正是最典型的"看起来对、其实没生效"。
 *
 * ## 为什么在**服务端**触发，而不是前端
 * 改名不止一个入口：面板按钮、`curl`、以后的 SDK、批次 3 的批量清理脚本。
 * 把刷新放在前端就只能覆盖按钮那条路（我按主理人的 curl 验法复现时就是这个问题）。
 * 服务端在**写成功之后**排一次刷新，所有入口天然一致。
 *
 * ## 为什么要节流
 * 15 万条那次全量挖掘约 15 秒。用户连续改 5 个名字（批次 3 的清理场景）时，
 * 若不节流就是 5 次全量挖掘串在一起。这里做**尾沿防抖**：最后一次修改后 `delayMs`
 * 内没有新修改才跑；若跑的过程中又来新修改，只记一个"待补跑"，跑完再补一次。
 *
 * ## 语义边界
 * - 刷新**失败不影响写操作**（写已经成功），只记一行 warning 日志；
 * - 返回给调用方的 `graph_refresh` 只表示"已排队"，不承诺何时完成 ——
 *   前端据此显示"图谱正在刷新"，而不是假装已刷新。
 */
import { runMiningPipeline } from "@knowself/mining";
import type { PersonStore } from "@knowself/person-store";

/** 默认防抖间隔（毫秒）。真实数据 109 节点的挖掘是秒级，5 秒足够合并连续编辑。 */
export const DEFAULT_DEBOUNCE_MS = 5000;

/** 一次调度的返回（进写接口响应体）。 */
export interface RefreshSchedule {
  /** 是否已排队（节流命中时也是 true——调用方只关心"会不会刷"）。 */
  scheduled: boolean;
  /** 本次合并窗口（毫秒）。 */
  debounce_ms: number;
}

interface SchedulerState {
  timer: ReturnType<typeof setTimeout> | null;
  /** 是否已有一次挖掘在跑（跑的过程中来的修改只记 pending）。 */
  running: boolean;
  /** 跑的过程中又来了修改 → 跑完补一次。 */
  pending: boolean;
  store: PersonStore | null;
}

/** 进程内单例（每个插件实例一份）。 */
const state: SchedulerState = { timer: null, running: false, pending: false, store: null };

/**
 * 真正跑一次挖掘（可注入，便于测试）。
 * @param store 人物库
 */
export type MineRunner = (store: PersonStore) => Promise<unknown>;

/** 默认掘进器。 */
const defaultRunner: MineRunner = (store) => runMiningPipeline({ store, write: true });

/** 当前注入的掘进器（测试可替换）。 */
let runner: MineRunner = defaultRunner;

/** 当前防抖窗口（测试可调小，生产用 {@link DEFAULT_DEBOUNCE_MS}）。 */
let debounceMs: number = DEFAULT_DEBOUNCE_MS;

/**
 * 调整防抖窗口（**仅测试用**）：默认 5 秒，测试里调成 10ms 免得每个用例等 5 秒。
 * @param ms 新的窗口；传 `null` 恢复默认
 */
export function setDebounceForTest(ms: number | null): void {
  debounceMs = ms ?? DEFAULT_DEBOUNCE_MS;
}

/**
 * 替换掘进器（**仅测试用**；生产不调用）。
 * @param next 新的掘进器；传 `null` 恢复默认
 */
export function setMineRunnerForTest(next: MineRunner | null): void {
  runner = next ?? defaultRunner;
}

/**
 * 重置调度器（**仅测试用**）：清计时器与内部状态。
 */
export function resetSchedulerForTest(): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.running = false;
  state.pending = false;
  state.store = null;
}

/**
 * 排一次图谱刷新（尾沿防抖 + 单飞）。
 *
 * @param store 人物库（写操作已成功后才调用）
 * @param delayMs 防抖窗口；测试可传 0
 * @returns 见 {@link RefreshSchedule}
 */
export function scheduleGraphRefresh(
  store: PersonStore,
  delayMs: number = debounceMs,
): RefreshSchedule {
  state.store = store;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void runOnce();
  }, delayMs);
  // Node 的 setTimeout 会拖住进程退出；这里 unref，让 CLI / 测试跑完就能走
  const timer = state.timer as unknown as { unref?: () => void };
  timer.unref?.();
  return { scheduled: true, debounce_ms: delayMs };
}

/**
 * 执行一次挖掘（若已有在跑，只记 pending）。
 */
async function runOnce(): Promise<void> {
  if (state.running) {
    state.pending = true;
    return;
  }
  const store = state.store;
  if (store === null) return;
  state.running = true;
  try {
    await runner(store);
  } catch (err) {
    // 刷新失败**不影响**已经成功的写操作，只留日志（stderr 也是既有审计通道）
    try {
      console.error(
        `[knowself][graph-refresh] ${JSON.stringify({
          event: "graph_refresh_failed",
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        })}`,
      );
    } catch {
      /* stderr 不可用不影响主流程 */
    }
  } finally {
    state.running = false;
    if (state.pending) {
      state.pending = false;
      // 跑完立刻补一次（对应"跑的过程中又改了"），不再等防抖窗口
      void runOnce();
    }
  }
}

/**
 * 等待当前排队的刷新结束（**仅测试用**）。
 * @param timeoutMs 超时
 */
export async function waitForIdleForTest(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.timer === null && !state.running && !state.pending) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
