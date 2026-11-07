/**
 * ProposalCard — AI 蒸馏建议的审阅卡片（接受 / 编辑 / 拒绝）。
 *
 * 从 SourcesPage 详情抽屉抽出的共享组件，供「待整理」收件箱与「资料」页复用。
 * 审阅 UI 单一实现，避免两处分叉。
 */
import { useState } from "react";
import type { IngestionProposal, DecideProposalRequest } from "@knowself/contracts";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";

interface ProposalCardProps {
  proposal: IngestionProposal;
  /** 可选：来源全文，用于展开 source_excerpts 引用片段。收件箱无全文时省略。 */
  sourceText?: string;
  onDecide: (id: string, body: DecideProposalRequest) => void | Promise<void>;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "sources.proposal.pending",
  accepted: "sources.proposal.accepted",
  edited: "sources.proposal.edited",
  rejected: "sources.proposal.rejected",
};

const STATUS_VARIANT: Record<string, "default" | "info" | "outline"> = {
  pending: "default",
  accepted: "info",
  edited: "info",
  rejected: "outline",
};

export function ProposalCard({ proposal: p, sourceText, onDecide }: ProposalCardProps) {
  const t = useT();
  const [expandedBody, setExpandedBody] = useState(false);
  const [expandedExcerpt, setExpandedExcerpt] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.proposed_body);

  const pending = p.status === "pending";

  const targetLabel =
    p.target.kind === "core"
      ? t("sources.detail.target.core")
      : p.target.kind === "card_section"
        ? t("sources.detail.target.card", { k: p.target.card_key, s: p.target.section })
        : p.target.kind === "chat_message"
          ? t("sources.detail.target.chat_message", { n: String(p.target.message_ids.length) })
          : t("sources.detail.target.journal", { d: p.target.date });

  return (
    <Card compact className={cn(!pending && "opacity-60")}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge variant="info" className="text-[10px]">
            {targetLabel}
          </Badge>
          {!pending && (
            <Badge variant={STATUS_VARIANT[p.status] ?? "default"}>
              {t(STATUS_LABEL[p.status] ?? p.status)}
            </Badge>
          )}
        </div>

        {/* 建议正文 / 编辑态 */}
        {editing ? (
          <textarea
            className="min-h-[100px] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[13px] leading-[1.55]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : (
          <div>
            <p className="whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--color-fg)]">
              {expandedBody || p.proposed_body.length <= 150
                ? p.proposed_body
                : p.proposed_body.slice(0, 150) + "..."}
            </p>
            {p.proposed_body.length > 150 && (
              <button
                type="button"
                onClick={() => setExpandedBody((v) => !v)}
                className="mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
              >
                {expandedBody ? t("sources.detail.collapse") : t("sources.detail.expand")}
              </button>
            )}
          </div>
        )}

        {/* 来源摘录（仅当提供 sourceText 时可展开） */}
        {sourceText && p.source_excerpts.length > 0 && !editing && (
          <div>
            <button
              type="button"
              onClick={() => setExpandedExcerpt((v) => !v)}
              className="text-[11px] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
            >
              {expandedExcerpt
                ? t("sources.detail.collapse_refs")
                : t("sources.detail.view_refs", { n: String(p.source_excerpts.length) })}
            </button>
            {expandedExcerpt && (
              <div className="mt-1 space-y-1">
                {p.source_excerpts.map((ex, i) => (
                  <p
                    key={i}
                    className="rounded-[var(--radius-sm)] bg-[var(--color-bg-muted)] p-2 text-[11px] leading-[1.5] text-[var(--color-fg-muted)]"
                  >
                    {sourceText.slice(ex.start, ex.end)}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 决策按钮 */}
        {pending && !editing && (
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onDecide(p.id, { decision: "accept" })}
            >
              {t("sources.detail.accept")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t("sources.detail.edit")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void onDecide(p.id, { decision: "reject" })}
            >
              {t("sources.detail.reject")}
            </Button>
          </div>
        )}

        {/* 编辑态按钮 */}
        {pending && editing && (
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("sources.detail.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void onDecide(p.id, { decision: "edit", body: draft });
                setEditing(false);
              }}
            >
              {t("sources.detail.submit")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
