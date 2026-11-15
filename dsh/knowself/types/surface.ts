/**
 * knowSelf 插件接入面的「工具名清单」常量。
 *
 * 注意：本文件早期版本包含以 `unknown` 占位的「目标形状」接口（KnowselfCtx /
 * KnowselfToolDef / L1SummarySection），用于编码前的目标契约。实际 dsh 类型已
 * 在 `src/index.ts` / `src/tools.ts` 直接用 `@deepseek-ai/dsh-*` 真实类型，故此处
 * 仅保留稳定的工具名清单，供测试与文档引用。
 */

/**
 * knowSelf 领域工具清单（与 `docs/dsh-integration/03-集成设计.md` §3.2 对齐）。
 * 这是 knowSelf 独有能力进入 dsh agent 的主通道。
 */
export const KNOWSELF_TOOL_NAMES = [
  "knowself_get_profile",
  "knowself_get_card",
  "knowself_search",
  "knowself_get_journal",
  "knowself_append_journal",
  "knowself_list_persons",
  "knowself_get_person",
  "knowself_person_events",
  "knowself_metrics",
  "knowself_network",
  "knowself_intent",
  "knowself_ingest",
  "knowself_list_proposals",
  "knowself_decide_proposal",
  "knowself_import_chat",
] as const;

export type KnowselfToolName = (typeof KNOWSELF_TOOL_NAMES)[number];

export const KNOWSELF_TOOL_COUNT = KNOWSELF_TOOL_NAMES.length;
