/**
 * `POST /knowself-api/write/proposals-accept-batch`（W-9）
 *
 * ## 为什么必须在 W-9 里
 * `chat-import` 的 `auto_commit` 默认 `false`（不替用户做复核决定），且只采纳**本次新建**的
 * proposal。两者都对，但合起来会得出：用户导入 80 条 → 库里 0 条 → 要进图谱得点 80 次。
 * **默认值安全了，功能却等于不可用。** 所以批量采纳必须与导入一起上线。
 *
 * ## 边界
 * - 只采纳 **pending**：已 accepted / rejected / edited 的一律不碰（那是用户已决策的历史）；
 * - 只采纳**本批次/本资料**下的：不做"全库清空式采纳"；
 * - 走写通道（`/knowself-api/write/*` + `x-knowself-write` 守卫），与其它写端点一致；
 * - 写一行结构化审计日志，事后能查到"谁一键采纳了多少条"。
 */
import type { KnowselfServices } from "../services.js";
import { BadRequestError, degradedBody, type DispatchResult } from "./http.js";

/** 请求体：`source_id` 与 `batch_id` 二选一。 */
interface BatchBody {
  source_id?: string;
  batch_id?: string;
  reason?: string;
}

/**
 * 解析请求体。
 *
 * @param raw 原始 body
 * @returns 规范化后的入参
 * @throws BadRequestError 两者都缺 / 类型不对
 */
function parseBatchBody(raw: unknown): BatchBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const body = raw as Record<string, unknown>;
  const out: BatchBody = {};
  for (const key of ["source_id", "batch_id", "reason"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new BadRequestError(`字段 ${key} 必须是非空字符串`);
    }
    out[key] = value.trim();
  }
  if (out.source_id === undefined && out.batch_id === undefined) {
    throw new BadRequestError("必须提供 source_id 或 batch_id 之一");
  }
  // proposal 上目前只持久化 source_id；batch_id 没有落到 proposal 行里，
  // 按它过滤会静默什么都不采纳（比报错更糟），所以直接拒绝并说明。
  if (out.source_id === undefined && out.batch_id !== undefined) {
    throw new BadRequestError(
      "按 batch_id 批量采纳暂不支持（proposal 未持久化 batch_id），请改用 source_id",
    );
  }
  return out;
}

/**
 * 采纳某条资料下所有 pending 的 chat_message proposal。
 *
 * @param services 装配后的服务
 * @param raw 请求体
 * @returns `{ accepted, failed, failed_ids }`
 */
export async function acceptProposalsBatch(
  services: KnowselfServices,
  raw: unknown,
): Promise<DispatchResult> {
  const body = parseBatchBody(raw);
  const ingestion = services.ingestion;
  if (ingestion === undefined) {
    return degradedBody("批量采纳需要摄入层，当前未就绪", "ingestion");
  }

  const sourceId = body.source_id as string;
  // 资料必须存在（未知 id → 404，与其它端点同语义）
  try {
    services.profileStore.sources.get(sourceId);
  } catch {
    return { status: 404, body: { error: "not_found" } };
  }

  const pending = ingestion
    .listProposalsByStatus("pending")
    .filter((p) => p.source_id === sourceId)
    .filter((p) => (p.target as { kind?: string }).kind === "chat_message");

  let accepted = 0;
  const failedIds: string[] = [];
  for (const proposal of pending) {
    try {
      ingestion.acceptProposal(proposal.id);
      accepted += 1;
    } catch {
      failedIds.push(proposal.id);
    }
  }

  try {
    console.error(
      `[knowself][proposals] ${JSON.stringify({
        event: "proposals_accept_batch",
        source_id: sourceId,
        // proposal 行未持久化 batch_id，故这里恒为 null（字段保留以对齐审计格式）
        batch_id: null,
        accepted,
        failed: failedIds.length,
        reason: body.reason ?? null,
        at: new Date().toISOString(),
      })}`,
    );
  } catch {
    /* stderr 不可用不影响主流程 */
  }

  return {
    status: 200,
    body: { accepted, failed: failedIds.length, failed_ids: failedIds },
  };
}
