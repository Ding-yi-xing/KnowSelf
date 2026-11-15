import type {
  SourceId,
  ProposalId,
  IngestionProposal,
  DecideProposalRequest,
  ProposalTarget,
  ProposalStatus,
} from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ProfileNotFoundError, ConstraintViolationError } from "../errors";
import { parseJsonColumn } from "../json";

interface ProposalRow {
  id: string;
  source_id: string;
  target_kind: string;
  target_ref: string;
  proposed_body: string;
  reasoning: string;
  source_excerpts: string;
  produced_by_provider: string;
  status: string;
  user_edited_body: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToProposal(row: ProposalRow): IngestionProposal {
  const target = parseJsonColumn<ProposalTarget>(row.target_ref, {
    kind: "core",
  } as ProposalTarget);
  // Override kind from column for safety
  target.kind = row.target_kind as ProposalTarget["kind"];

  return {
    id: row.id,
    source_id: row.source_id,
    target,
    proposed_body: row.proposed_body,
    reasoning: row.reasoning,
    source_excerpts: parseJsonColumn<{ start: number; end: number }[]>(row.source_excerpts, []),
    produced_by_provider: row.produced_by_provider,
    status: row.status as ProposalStatus,
    user_edited_body: row.user_edited_body,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

export function createProposalsRepo(db: ProfileDb) {
  return {
    insertMany(items: IngestionProposal[]): void {
      const stmt = db.prepare(
        `INSERT INTO ingestion_proposals
         (id, source_id, target_kind, target_ref, proposed_body, reasoning,
          source_excerpts, produced_by_provider, status, user_edited_body,
          created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of items) {
        stmt.run(
          p.id,
          p.source_id,
          p.target.kind,
          JSON.stringify(p.target),
          p.proposed_body,
          p.reasoning,
          JSON.stringify(p.source_excerpts),
          p.produced_by_provider,
          p.status,
          p.user_edited_body ?? null,
          p.created_at,
          p.decided_at ?? null,
        );
      }
    },

    /**
     * 写入自动归档判定结果（批次 2 / B2-1）。
     *
     * ## 为什么写进 `target_ref` 而不是加列
     * `target_ref` 本来就是这个 proposal 的 **JSON 载荷**（`rowToProposal` 直接
     * `parseJsonColumn<ProposalTarget>`），不同 `target_kind` 天然带不同字段。
     * 加列会让 `sqlite_master` 里的建表语句变样，直接打挂
     * `db-migration-proposals.test.ts` 的两条 golden 断言（列/行/索引逐字比对）——
     * 那是"schema 变更必须留痕"的护栏，不该为了加三个诊断字段去动它。
     * 而且这三列**从不参与 SQL 查询**（只在响应里展示），放 JSON 没有性能代价。
     *
     * @param proposalId 提案 id
     * @param verdict 判定结果（写进 target 的 `classification` 字段）
     */
    setClassification(
      proposalId: ProposalId,
      verdict: { target: string; confidence: number; classifier: string },
    ): void {
      const row = db
        .prepare("SELECT target_ref FROM ingestion_proposals WHERE id = ?")
        .get(proposalId) as { target_ref: string } | undefined;
      if (row === undefined) {
        // 用普通 Error：`ProfileRefKind` 目前只覆盖 core/card/journal 三种，
        // 没有 `proposal`——硬塞一个"看起来像"的 kind 会让错误语义失真。
        throw new Error(`提案不存在: ${proposalId}`);
      }
      // 用裸 JSON.parse（而不是 `parseJsonColumn`）：这里要的是"原样载荷"，
      // 而 `parseJsonColumn` 的泛型会被 `ProposalTarget` 联合类型约束，反而要来回断言。
      let target: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.target_ref);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          target = parsed as Record<string, unknown>;
        }
      } catch {
        target = {};
      }
      target["suggested_target"] = verdict.target;
      target["confidence"] = verdict.confidence;
      target["classifier"] = verdict.classifier;
      db.prepare("UPDATE ingestion_proposals SET target_ref = ? WHERE id = ?").run(
        JSON.stringify(target),
        proposalId,
      );
    },

    listBySource(sourceId: SourceId): IngestionProposal[] {
      const rows = db
        .prepare("SELECT * FROM ingestion_proposals WHERE source_id = ? ORDER BY created_at DESC")
        .all(sourceId) as ProposalRow[];
      return rows.map(rowToProposal);
    },

    /**
     * 跨 source 全局列出 proposals，按状态过滤（"all" 不过滤）。
     * 用于「待整理」收件箱：listByStatus("pending")。
     */
    listByStatus(
      status: ProposalStatus | "all" = "pending",
      limit = 100,
    ): IngestionProposal[] {
      const rows = (
        status === "all"
          ? db
              .prepare("SELECT * FROM ingestion_proposals ORDER BY created_at DESC LIMIT ?")
              .all(limit)
          : db
              .prepare(
                "SELECT * FROM ingestion_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?",
              )
              .all(status, limit)
      ) as ProposalRow[];
      return rows.map(rowToProposal);
    },

    countByStatus(): Partial<Record<ProposalStatus, number>> {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS count FROM ingestion_proposals GROUP BY status")
        .all() as { status: ProposalStatus; count: number }[];
      return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<
        Record<ProposalStatus, number>
      >;
    },

    /**
     * Deletes pending content proposals for a forced re-distill.
     *
     * 用途：强制重蒸（`force: true`）前清场。**绝不碰 accepted / rejected /
     * edited** —— those are user decisions. `source_distill` is also retained:
     * it is a pending review request, not a prior model output.
     *
     * @param sourceId 资料 id
     * @returns 实际删除的行数
     */
    deletePendingBySource(sourceId: SourceId): number {
      const info = db
        .prepare(
          "DELETE FROM ingestion_proposals WHERE source_id = ? AND status = 'pending' AND target_kind <> 'source_distill'",
        )
        .run(sourceId);
      return info.changes;
    },

    /**
     * Claims a source-distill review request. The conditional update is the
     * concurrency boundary for repeated clicks or multiple windows.
     */
    claimSourceDistill(id: ProposalId): IngestionProposal | null {
      const info = db
        .prepare(
          `UPDATE ingestion_proposals
           SET status = 'processing'
           WHERE id = ? AND target_kind = 'source_distill' AND status = 'pending'`,
        )
        .run(id);
      return info.changes === 1 ? this.get(id) : null;
    },

    /** Marks a previously claimed source-distill request as accepted. */
    completeSourceDistill(id: ProposalId, now: string): IngestionProposal | null {
      const info = db
        .prepare(
          `UPDATE ingestion_proposals
           SET status = 'accepted', decided_at = ?
           WHERE id = ? AND target_kind = 'source_distill' AND status = 'processing'`,
        )
        .run(now, id);
      return info.changes === 1 ? this.get(id) : null;
    },

    /** Releases a failed source-distill claim so a user may retry it. */
    releaseSourceDistill(id: ProposalId): IngestionProposal | null {
      const info = db
        .prepare(
          `UPDATE ingestion_proposals
           SET status = 'pending'
           WHERE id = ? AND target_kind = 'source_distill' AND status = 'processing'`,
        )
        .run(id);
      return info.changes === 1 ? this.get(id) : null;
    },

    get(id: ProposalId): IngestionProposal {
      const row = db.prepare("SELECT * FROM ingestion_proposals WHERE id = ?").get(id) as
        | ProposalRow
        | undefined;
      if (!row) {
        throw new ProfileNotFoundError(`proposal 不存在: ${id}`);
      }
      return rowToProposal(row);
    },

    decide(id: ProposalId, decision: DecideProposalRequest, now: string): IngestionProposal {
      const proposal = this.get(id);
      if (proposal.status !== "pending") {
        throw new ConstraintViolationError(
          `proposal ${id} 状态为 ${proposal.status}，不允许再决策`,
        );
      }

      let newStatus: ProposalStatus;
      let userEditedBody: string | null = null;

      if (decision.decision === "accept") {
        newStatus = "accepted";
      } else if (decision.decision === "edit") {
        newStatus = "edited";
        userEditedBody = decision.body;
      } else {
        newStatus = "rejected";
      }

      db.prepare(
        `UPDATE ingestion_proposals
         SET status = ?, user_edited_body = ?, decided_at = ?
         WHERE id = ?`,
      ).run(newStatus, userEditedBody, now, id);

      return this.get(id);
    },
  };
}
