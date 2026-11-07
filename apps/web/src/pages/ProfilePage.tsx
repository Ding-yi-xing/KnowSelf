/**
 * ProfilePage — L1 核心档案编辑。
 * 视觉：表单卡片化，标签 + 输入分两行；保存按钮固定在底部 sticky 工具栏。
 */
import { useEffect, useState, useCallback, useMemo, type FormEvent } from "react";
import { Save } from "lucide-react";
import { useProfileStore } from "../stores/profile";
import { useTransport } from "../stores/transport-context";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { Toast, ToastViewport } from "../components/ui/toast";
import { useT } from "../lib/i18n";

export function ProfilePage() {
  const t = useT();
  const transport = useTransport();
  const core = useProfileStore((s) => s.core);
  const loading = useProfileStore((s) => s.loading);
  const saveCore = useProfileStore((s) => s.saveCore);
  const loadCore = useProfileStore((s) => s.loadCore);

  const [body, setBody] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void loadCore(transport);
  }, [loadCore, transport]);

  useEffect(() => {
    if (core) {
      setBody(core.body);
      setDisplayName(core.display_name);
    }
  }, [core]);

  const dirty = useMemo(
    () => editing && (body !== core?.body || displayName !== core?.display_name),
    [editing, body, displayName, core],
  );

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!dirty) return;
      setSaving(true);
      try {
        await saveCore({ body, display_name: displayName }, transport);
        setEditing(false);
        setToast(t("profile.saved"));
        setTimeout(() => setToast(null), 2200);
      } finally {
        setSaving(false);
      }
    },
    [dirty, body, displayName, saveCore, transport],
  );

  const cancel = useCallback(() => {
    if (core) {
      setBody(core.body);
      setDisplayName(core.display_name);
    }
    setEditing(false);
  }, [core]);

  if (loading && !core) return <PageLoading />;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("profile.title")}
        subtitle={t("profile.subtitle")}
        actions={
          editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
                {t("profile.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="profile-core-save"
                onClick={() => void handleSubmit()}
                loading={saving}
                disabled={!dirty}
                iconLeft={!saving ? <Save className="size-3.5" strokeWidth={2.4} /> : undefined}
              >
                {t("profile.save")}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              data-testid="profile-core-edit"
              onClick={() => setEditing(true)}
            >
              {t("profile.edit")}
            </Button>
          )
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-8">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
            <FieldRow label={t("profile.display_name.label")} hint={t("profile.display_name.hint")}>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={!editing}
                placeholder={t("profile.display_name.placeholder")}
              />
            </FieldRow>

            <FieldRow label={t("profile.body.label")} hint={t("profile.body.hint")}>
              {editing ? (
                <Textarea
                  data-testid="profile-core-input"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={18}
                  className="font-mono text-[13px] leading-[1.7]"
                  placeholder={t("profile.body.placeholder")}
                />
              ) : (
                <Card className="min-h-[400px]">
                  {body ? (
                    <pre className="whitespace-pre-wrap font-sans text-[14px] leading-[1.7] text-[var(--color-fg)]">
                      {body}
                    </pre>
                  ) : (
                    <p className="text-[13.5px] text-[var(--color-fg-subtle)]">
                      {t("profile.empty")}
                    </p>
                  )}
                </Card>
              )}
            </FieldRow>

            {core && (
              <p className="text-[12px] text-[var(--color-fg-subtle)]">
                {t("profile.updated_prefix")}
                {core.updated_at}
              </p>
            )}
          </form>
        </div>
      </div>

      {toast && (
        <ToastViewport>
          <Toast variant="success" testId="toast-success">
            {toast}
          </Toast>
        </ToastViewport>
      )}
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="text-[13px] font-medium text-[var(--color-fg)]">{label}</label>
        {hint && <span className="text-[12px] text-[var(--color-fg-subtle)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
    </div>
  );
}
