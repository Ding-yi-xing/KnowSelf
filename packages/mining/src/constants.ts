/**
 * 常量清单（DESIGN-12 附录 A，逐字抄录，不得散落硬编码）。
 * 改动必须回写 DESIGN-12 附录 A。
 */

/** 会话片段切分间隙：相邻消息间隔 > 此值即切段（与 DESIGN-10 §7.1 消息窗口同值）。 */
export const SESSION_GAP_MS = 1_800_000;

/** §4.2 成对成员数降级闸门：超过则不做全对（all-pairs）共现。 */
export const MAX_PAIRWISE_MEMBERS = 200;

/** §4.1 话题节点最小出现次数。 */
export const MIN_TOPIC_COUNT = 3;

/** §4.5 共现边最小强度，低于此值裁剪。 */
export const MIN_EDGE_STRENGTH = 0.05;

/** 图谱节点 / 边上限（NFR-11 渲染预算）。 */
export const MAX_NODES = 3000;
export const MAX_EDGES = 10000;

/** §5.2 意图判定分差阈值：规则最高分与次高分之差 ≥ 此值才定类，否则 `other`。 */
export const INTENT_DELTA = 1.0;

/** §5.2 LLM 增强层成本闸：单次全量打标最多调用的消息数（P2 层）。 */
export const MAX_LLM_CALLS = 200;

/** §6.1 价值打分近因衰减时间常数（天）。 */
export const RECENCY_TAU_DAYS = 30;

/** §3.3.4 回复延迟样本量阈值：超过则转 1000 桶对数直方图近似分位数。 */
export const HISTOGRAM_THRESHOLD = 200_000;

/** §4.6 图谱快照保留份数。 */
export const GRAPH_SNAPSHOT_KEEP = 10;

/** 指标生产版本位（§9.3 重建比对用；规则变化时递增）。 */
export const METRICS_PRODUCED_BY = "mining:metrics-v1";
/** 意图规则生产版本位（§9.3）。 */
export const INTENT_PRODUCED_BY = "mining:intent-rule-v1";
/** 关系生产版本位（§9.3）。 */
export const RELATION_PRODUCED_BY = "mining:rel-v1";
/** 图谱生产版本位（§9.3）。 */
export const GRAPH_PRODUCED_BY = "mining:graph-v1";
