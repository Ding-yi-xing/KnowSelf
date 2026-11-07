/**
 * 常量集中定义（DESIGN-13 附录 A：不得散落硬编码）。
 * 本工单落地 2 个；其余常量（`MAX_EVIDENCE_REFS` / `GRAPH_SNAPSHOT_KEEP` /
 * `AUTO_MERGE_*`）随各自工单（merge / mining 重建）加入，不提前占位。
 */

/** `content_excerpt` 截断长度（DESIGN-13 §8.2：查询期截断，**不落库**）。 */
export const TRACE_EXCERPT_CHARS = 200;

/** committed staging 保留期（DESIGN-13 附录 A / DESIGN-11 §4.3：≥30 天后可清理）。 */
export const STAGING_PRUNE_DAYS = 30;
