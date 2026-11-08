/**
 * TemplatesPage — 模板列表 / 新建 / 删除。
 * 迁移前行为：内置与自定义分组、内置不可删、删除确认、操作后 Toast。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { profileApi, type ProfileApi } from "../../transport/profileApi";
import type { TemplateRecord } from "../../transport/types";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, Toast } from "../../ui/primitives";

export function TemplatesPage({ client = profileApi }: { client?: ProfileApi }) {
  const [items, setItems] = useState<TemplateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await client.listTemplates());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const remove = useCallback(async (id: string) => {
    if (id.startsWith("builtin-")) {
      notify("内置模板不可删除");
      setConfirmId(null);
      return;
    }
    try {
      await client.deleteTemplate(id);
      setItems((list) => list.filter((item) => item.id !== id));
      notify("已删除");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setConfirmId(null);
    }
  }, [client, notify]);

  const builtins = items.filter((item) => item.id.startsWith("builtin-"));
  const customs = items.filter((item) => !item.id.startsWith("builtin-"));

  return (
    <div className="content-inner">
      <PageHeader title="模板" subtitle="提示词模板，可在对话中复用。" />
      <div className="card-actions" style={{ marginBottom: 16, justifyContent: "flex-end" }}>
        <Button variant="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "取消" : "新建模板"}
        </Button>
      </div>
      {error !== null && <ErrorBanner message={error} />}

      {creating && (
        <NewTemplateForm
          client={client}
          onCreated={(created) => {
            setItems((list) => [...list, created]);
            setCreating(false);
            notify("已创建");
          }}
          onError={notify}
        />
      )}

      {loading && items.length === 0 ? (
        <Spinner label="加载模板" />
      ) : items.length === 0 ? (
        <EmptyState title="暂无模板" description="新建模板后会出现在这里。" />
      ) : (
        <>
          <TemplateGroup title="内置模板" list={builtins} confirmId={confirmId} setConfirmId={setConfirmId} onRemove={remove} />
          <TemplateGroup title="自定义模板" list={customs} confirmId={confirmId} setConfirmId={setConfirmId} onRemove={remove} />
        </>
      )}
      {toast !== null && <Toast message={toast} />}
    </div>
  );
}

function TemplateGroup({
  title, list, confirmId, setConfirmId, onRemove,
}: {
  title: string;
  list: readonly TemplateRecord[];
  confirmId: string | null;
  setConfirmId: (id: string | null) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  if (list.length === 0) return null;
  return (
    <>
      <h2 className="group-title">{title}</h2>
      {list.map((item) => (
        <Card key={item.id}>
          <div className="card-head">
            <strong>{item.name}</strong>
            <Badge tone={item.id.startsWith("builtin-") ? "info" : "neutral"}>
              {item.variables.length} 个变量
            </Badge>
          </div>
          <div className="card-meta">{item.description || "（无描述）"}</div>
          <div className="card-excerpt">{item.system_prompt_inject}</div>
          <div className="card-actions" style={{ marginTop: 10 }}>
            {confirmId === item.id ? (
              <>
                <Button variant="danger" onClick={() => void onRemove(item.id)}>确认删除</Button>
                <Button onClick={() => setConfirmId(null)}>取消</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmId(item.id)}>删除</Button>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}

function NewTemplateForm({
  client, onCreated, onError,
}: {
  client: ProfileApi;
  onCreated: (created: TemplateRecord) => void;
  onError: (message: string) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!id.trim() || !name.trim() || !prompt.trim()) {
      onError("ID、名称与提示词不能为空");
      return;
    }
    setBusy(true);
    try {
      onCreated(await client.createTemplate({
        id: id.trim(),
        name: name.trim(),
        description: description.trim(),
        system_prompt_inject: prompt,
        variables: [],
      }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="form-grid">
        <label>ID<input className="textarea form-input" value={id} onChange={(e) => setId(e.target.value)} aria-label="模板 ID" /></label>
        <label>名称<input className="textarea form-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="模板名称" /></label>
        <label>描述<input className="textarea form-input" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="模板描述" /></label>
        <label>提示词注入<textarea className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="提示词注入" /></label>
      </div>
      <div className="card-actions" style={{ marginTop: 12 }}>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>保存</Button>
      </div>
    </Card>
  );
}
