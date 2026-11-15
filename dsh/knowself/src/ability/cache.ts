/**
 * 能力快照的**进程内缓存**（T03）。
 *
 * ## 为什么用指纹而不是 TTL
 * 能力数据来自 `profile.sqlite` 的 cards / card_sections，写入是低频事件（蒸馏完成后落卡）。
 * 用 TTL 会在「刚改完资料立刻看能力图」时返回陈旧结果，用指纹则既不陈旧也不多算：
 * 每次请求只做一次**只读扫描 + sha1**（真实数据 11 张卡/29 节，<2ms），指纹不变直接返回缓存对象。
 *
 * ## 指纹为什么必须含 `sections.body`
 * 真实写入路径里存在「卡记录没动、只改了某一节正文」的情况（分节 append / 编辑）。
 * 那种变更在 `cards.updated_at` 上看不出来 —— 只 hash `updated_at` 会命中陈旧缓存，
 * 用户改了资料却看不到能力变化。见 `extract.ts: computeAbilityFingerprint()`。
 *
 * ## 升级路径（架构案 §A）
 * 若将来要跨进程复用，把本文件的 Map 换成单行表 `ability_snapshot(id=1, payload_json,
 * fingerprint, generated_at)` 即可，`getAbilitySnapshot()` 签名不变。
 */
import type { AbilitySnapshot } from "@knowself/contracts";
import {
  computeAbilityFingerprint,
  extractAbilitySnapshot,
  type AbilityStoreLike,
} from "./extract.js";

/** 缓存统计（供测试与诊断读，不进快照）。 */
export interface AbilityCacheStats {
  /** 命中次数。 */
  hits: number;
  /** 未命中（重算）次数。 */
  misses: number;
  /** 最近一次计算的指纹。 */
  last_fingerprint: string | null;
}

/** 缓存条目。 */
interface CacheEntry {
  fingerprint: string;
  snapshot: AbilitySnapshot;
}

/** 可注入时钟（测试用）。 */
export interface SnapshotOptions {
  /** 生成时间（ISO8601）；仅在**重算**时使用。 */
  now?: string;
}

/** 取快照的结果 + 是否命中缓存（路由用它打 `X-Ability-Cache` 响应头）。 */
export interface AbilitySnapshotResult {
  snapshot: AbilitySnapshot;
  cache: "hit" | "miss";
}

/**
 * 能力快照缓存。
 *
 * 进程内单槽（按数据根目录隔离由调用方保证：一个 store 一个 cache 实例）。
 */
export class AbilitySnapshotCache {
  private entry: CacheEntry | null = null;
  private hits = 0;
  private misses = 0;

  /**
   * 取快照，并区分「命中/重算」。
   *
   * @param store 数据源（`ProfileStore` 结构满足 `AbilityStoreLike`）
   * @param options 可选生成时间（仅重算时生效）
   * @returns `{ snapshot, cache }`；`cache="hit"` 时返回**同一个对象引用**
   */
  resolve(store: AbilityStoreLike, options: SnapshotOptions = {}): AbilitySnapshotResult {
    const fingerprint = computeAbilityFingerprint(store);
    if (this.entry !== null && this.entry.fingerprint === fingerprint) {
      this.hits += 1;
      return { snapshot: this.entry.snapshot, cache: "hit" };
    }
    this.misses += 1;
    const snapshot = extractAbilitySnapshot({
      store,
      fingerprint,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.entry = { fingerprint, snapshot };
    return { snapshot, cache: "miss" };
  }

  /**
   * 取快照（只要结果）。
   *
   * @param store 数据源
   * @param options 可选生成时间（仅重算时生效）
   * @returns 快照（缓存命中时返回**同一个对象引用**，调用方不得原地修改）
   */
  getSnapshot(store: AbilityStoreLike, options: SnapshotOptions = {}): AbilitySnapshot {
    return this.resolve(store, options).snapshot;
  }

  /** 清空缓存（测试 / 强制重算用）。 */
  clear(): void {
    this.entry = null;
  }

  /** 读统计。 */
  stats(): AbilityCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      last_fingerprint: this.entry?.fingerprint ?? null,
    };
  }
}

/**
 * 进程级默认缓存。
 *
 * 插件侧装配时也可以自建实例（`new AbilitySnapshotCache()`）按 rootDir 隔离；
 * 单进程单数据根的常规路径直接用这个即可。
 */
export const abilitySnapshotCache = new AbilitySnapshotCache();

/**
 * 便捷入口：用默认缓存取快照。
 *
 * @param store 数据源
 * @param options 可选生成时间
 * @returns 能力快照
 */
export function getAbilitySnapshot(
  store: AbilityStoreLike,
  options: SnapshotOptions = {},
): AbilitySnapshot {
  return abilitySnapshotCache.getSnapshot(store, options);
}
