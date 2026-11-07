/**
 * InboxPage —「待整理」收件箱。
 *
 * 集中显示所有 pending 的 AI 蒸馏建议（来自对话自动蒸馏 + 资料蒸馏），
 * 用户在这里一站式接受 / 编辑 / 拒绝，落档进画像。
 * 这是「AI 代录」体验的核心入口：用户只管聊天，画像在这里审一下即可。
 */
import { useEffect, useCallback, useState } from "react";
import { Inbox } from "lucide-react";
import type { DecideProposalRequest, ProposalId } from "@knowself/contracts";
import { useInboxStore } from "../stores/inbox";
import { useTransport } from "../stores/transport-context";
import { ProposalCard } from "../components/ProposalCard";
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/spinner";
import { Toast, ToastViewport } from "../components/ui/toast";
import { useT } from "../lib/i18n";

export function InboxPage() {
  const t = useT();
  const transport = useTransport();
  const pending = useInboxStore((s) => s.pending);
  const loading = useInboxStore((s) => s.loading);
  const load = useInboxStore((s) => s.load);
  const decide = useInboxStore((s) => s.decide);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "danger" } | null>(
    null,
  );

  useEffect(() => {
    void load(transport);
  }, [load, transport]);

  const handleDecide = useCallback(
    async (id: ProposalId, body: DecideProposalRequest) => {
      try {
        await decide(id, body, transport);
        setToast({ message: t("inbox.toast.done"), variant: "success" });
      } catch {
        setToast({ message: t("inbox.toast.fail"), variant: "danger" });
      }
      setTimeout(() => setToast(null), 2600);
    },
    [decide, transport, t],
  );

  if (loading && pending.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          {pending.length === 0 ? (
            <div className="flex h-[calc(100vh-12rem)] items-center justify-center">
              <EmptyState
                icon={<Inbox className="size-6" strokeWidth={1.8} />}
                title={t("inbox.empty.title")}
                description={t("inbox.empty.desc")}
              />
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((p) => (
                <ProposalCard key={p.id} proposal={p} onDecide={handleDecide} />
              ))}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <ToastViewport>
          <Toast variant={toast.variant === "success" ? "success" : "danger"}>
            {toast.message}
          </Toast>
        </ToastViewport>
      )}
    </div>
  );
}
