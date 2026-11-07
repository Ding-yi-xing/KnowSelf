/**
 * InboxPage —— 试点页：「待整理」收件箱。
 *
 * 迁移前交互（逐项对齐，实现全部重写）：
 *   - 挂载即拉取 pending 提案
 *   - 加载态 Spinner / 空态 EmptyState
 *   - 每条卡片显示摘要、来源摘录、分层信息；可「接受 / 编辑 / 拒绝」
 *   - 决策成功后该条从列表移除，并弹 2.6s Toast；失败弹危险态 Toast
 * 数据来自 knowSelf 后端 REST，不经过 dsh host。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api as defaultApi, type KnowSelfApi } from "../../transport/http";
import type { DecideBody, Proposal } from "../../transport/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  Toast,
} from "../../ui/primitives";

interface InboxPageProps {
  readonly client?: KnowSelfApi;
}

type ToastState = { message: string; variant: "success" | "danger" } | null;

export function InboxPage({ client = defaultApi }: InboxPageProps) {
  const [pending, setPending] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((next: NonNullable<ToastState>) => {
    setToast(next);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void client
      .listPending()
      .then((items) => {
        if (!cancelled) {
          setPending(items);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const decide = useCallback(
    async (id: string, body: DecideBody) => {
      try {
        await client.decide(id, body);
        setPending((items) => items.filter((item) => item.id !== id));
        showToast({ message: "已处理", variant: "success" });
      } catch (cause) {
        showToast({
          message: cause instanceof Error ? cause.message : "处理失败",
          variant: "danger",
        });
        throw cause;
      }
    },
    [client, showToast],
  );

  return (
    <div className="content-inner">
      <PageHeader title="待整理" subtitle="集中审阅 AI 蒸馏建议，接受后才写入画像。" />
      {error !== null && <ErrorBanner message={error} />}

      {loading && pending.length === 0 ? (
        <Spinner label="加载待整理" />
      ) : pending.length === 0 ? (
        <EmptyState title="暂无待整理内容" description="新的蒸馏建议会出现在这里。" />
      ) : (
        <div>
          {pending.map((proposal) => (
            <ProposalCardView key={proposal.id} proposal={proposal} onDecide={decide} />
          ))}
        </div>
      )}

      {toast !== null && <Toast message={toast.message} variant={toast.variant} />}
    </div>
  );
}

function ProposalCardView({
  proposal,
  onDecide,
}: {
  proposal: Proposal;
  onDecide: (id: string, body: DecideBody) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.proposed_body);
  const [busy, setBusy] = useState(false);

  const run = async (body: DecideBody) => {
    setBusy(true);
    try {
      await onDecide(proposal.id, body);
    } catch {
      /* Toast 由父级统一处理 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="card-head">
        <span className="card-meta">{proposal.created_at}</span>
        <Badge tone={proposal.target?.kind === "chat_message" ? "info" : "neutral"}>
          {proposal.target?.kind ?? "profile"}
        </Badge>
      </div>

      {editing ? (
        <textarea
          className="textarea"
          style={{ marginTop: 10 }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="编辑建议内容"
        />
      ) : (
        <div className="card-body">{proposal.proposed_body}</div>
      )}

      {!editing && proposal.source_excerpts.length > 0 && (
        <div className="card-excerpt">{proposal.source_excerpts.join("\n---\n")}</div>
      )}
      {proposal.reasoning !== null && <div className="card-meta">{proposal.reasoning}</div>}

      <div className="card-actions" style={{ marginTop: 12 }}>
        {editing ? (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run({ decision: "edit", body: draft })}
            >
              保存并接受
            </Button>
            <Button disabled={busy} onClick={() => setEditing(false)}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void run({ decision: "accept" })}>
              接受
            </Button>
            <Button disabled={busy} onClick={() => setEditing(true)}>
              编辑
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void run({ decision: "reject" })}>
              拒绝
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
