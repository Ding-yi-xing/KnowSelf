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
