/**
 * W-3：**单条** proposal 的采纳 / 拒绝（`POST /proposal/:id/accept` / `/reject`）。
 *
 * ## 为什么需要（不是与批量重复）
 * 批量端点只能按 `source_id` 一把梭（`routes/proposals-batch.ts`）。收件箱里用户看到的是
 * **一条条**提案，想"这条留下、那条丢掉"时，批量端点要么不在场（不同 source），
 * 要么把不该采的也采了。单条端点是"逐条复核"这个动作的最小实现。
 *
 * ## 为什么复用而不复制
 * 采纳/拒绝的真实逻辑在 `@knowself/ingestion`：`acceptProposal` / `rejectProposal`。
 * 本模块**只做** id 校验、状态前置检查、错误映射与审计，不重写任何落档逻辑
 * （`chat_message` 分支的 committer 调用、profile 写入、links 关联全在领域库里）。
 *
 * ## 错误语义（沿用既有码，不新造）
 *   - 缺 id / body 非对象 → 400（`BadRequestError`）
 *   - proposal 不存在 → 404 `{error:"not_found"}`
 *   - 已决策过的（不是 pending）→ 409 `{error:"not_pending", status}`
 *   - 摄入层未装配 → 503 degraded(layer="ingestion")
 */
import type { KnowselfServices } from "../services.js";
import { BadRequestError, degradedBody, sanitizeReason, type DispatchResult } from "./http.js";

/**
 * 写一行结构化审计（与 `proposals-batch` 同格式，便于事后合并检索）。
 *
 * @param event 事件名
 * @param payload 附加字段
 */
function audit(event: string, payload: Record<string, unknown>): void {
  try {
    console.error(
      `[knowself][proposals] ${JSON.stringify({ event, ...payload, at: new Date().toISOString() })}`,
    );
  } catch {
    /* stderr 不可用不影响主流程 */
  }
}

/**
 * 单条采纳。
 *
 * @param services 装配后的服务
 * @param proposalId 提案 id
 * @param raw 请求体（可选 `{ reason? }`，仅进审计）
 * @returns **200** + 决策后的 `IngestionProposal`
 */
export async function acceptOneProposal(
  services: KnowselfServices,
  proposalId: string,
  raw: unknown,
): Promise<DispatchResult> {
  return await decideOne(services, proposalId, raw, "accept");
}

/**
 * 单条拒绝。
 *
 * @param services 装配后的服务
 * @param proposalId 提案 id
 * @param raw 请求体（可选 `{ reason? }`）
 * @returns **200** + 决策后的 `IngestionProposal`
 */
export async function rejectOneProposal(
  services: KnowselfServices,
  proposalId: string,
  raw: unknown,
): Promise<DispatchResult> {
  return await decideOne(services, proposalId, raw, "reject");
}

/**
 * 采纳/拒绝的公共实现（唯一分支点是调哪个领域函数）。
 *
 * @param services 装配后的服务
 * @param proposalId 提案 id
 * @param raw 请求体
 * @param decision 决策
 * @returns `{status, body}`
 */
async function decideOne(
  services: KnowselfServices,
  proposalId: string,
  raw: unknown,
  decision: "accept" | "reject",
): Promise<DispatchResult> {
  if (proposalId.trim() === "") throw new BadRequestError("proposal id 缺失");

  let reason: string | undefined;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).reason;
    if (value !== undefined) {
      if (typeof value !== "string") throw new BadRequestError("字段 reason 必须是字符串");
      const trimmed = value.trim().slice(0, 200);
      if (trimmed !== "") reason = trimmed;
    }
  }

  const ingestion = services.ingestion;
  if (ingestion === undefined) {
    return degradedBody("单条决策需要摄入层，当前未就绪", "ingestion");
  }

  const pending = ingestion
    .listProposalsByStatus("pending")
    .find((proposal) => proposal.id === proposalId);
  if (pending === undefined) {
    // 不在 pending 里：要么不存在（404），要么已决策（409）——两者前端处置不同，必须区分
    const known = (["processing", "accepted", "rejected", "edited"] as const)
      .map((status) => ingestion.listProposalsByStatus(status).find((p) => p.id === proposalId))
      .find((p) => p !== undefined);
    if (known === undefined) return { status: 404, body: { error: "not_found" } };
    return { status: 409, body: { error: "not_pending", status: known.status } };
  }

  try {
    const updated =
      decision === "accept" && pending.target.kind === "source_distill"
        ? await ingestion.acceptSourceDistillProposal(proposalId)
        : decision === "accept"
          ? ingestion.acceptProposal(proposalId)
          : ingestion.rejectProposal(proposalId);
    audit(decision === "accept" ? "proposal_accept_one" : "proposal_reject_one", {
      proposal_id: proposalId,
      source_id: knownSourceId(pending),
      reason: reason ?? null,
    });
    return { status: 200, body: updated };
  } catch (err) {
    // 领域库的「已不是 pending」也归 409：与上面的前置检查保持同一语义
    if (err instanceof Error && /not pending|NotPending/i.test(err.message)) {
      return { status: 409, body: { error: "not_pending" } };
    }
    throw new Error(sanitizeReason(err instanceof Error ? err.message : String(err), "决策失败"));
  }
}

/**
 * 从提案上取 `source_id`（审计用；缺失时回 null，不抛）。
 * @param proposal 提案（结构上必有 source_id，这里对 any 形态做防御）
 * @returns source_id 或 null
 */
function knownSourceId(proposal: { source_id?: string }): string | null {
  return typeof proposal.source_id === "string" ? proposal.source_id : null;
}
