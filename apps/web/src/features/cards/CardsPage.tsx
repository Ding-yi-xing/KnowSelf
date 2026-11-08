/**
 * CardsPage — L2 画像卡片 master-detail。
 * 迁移前行为：左侧卡片列表、选中读详情、新建/编辑、保存（整张卡）、删除、空态与 Toast。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { profileApi, type ProfileApi } from "../../transport/profileApi";
import type { CardSection, CardSummary } from "../../transport/types";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, Toast } from "../../ui/primitives";

interface DraftSection { title: string; body: string }

export function CardsPage({ client = profileApi }: { client?: ProfileApi }) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sections, setSections] = useState<readonly CardSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await client.listCards());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const select = useCallback(async (key: string) => {
    setSelectedKey(key);
    setEditing(false);
    try {
      const detail = await client.getCard(key);
      setSections(detail.sections);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "读取卡片失败");
      setSections([]);
    }
  }, [client, notify]);

  const remove = useCallback(async (key: string) => {
    try {
      await client.deleteCard(key);
      setCards((list) => list.filter((card) => card.key !== key));
      if (selectedKey === key) { setSelectedKey(null); setSections([]); }
      notify("已删除");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "删除失败");
    }
  }, [client, notify, selectedKey]);

  const selected = cards.find((card) => card.key === selectedKey) ?? null;

  return (
    <div className="content-inner">
      <PageHeader title="卡片" subtitle="画像卡片与分区内容。" />
      <div className="card-actions" style={{ marginBottom: 16, justifyContent: "flex-end" }}>
        <Button variant="primary" onClick={() => { setSelectedKey(null); setSections([]); setEditing(true); }}>
          新建卡片
        </Button>
      </div>
      {error !== null && <ErrorBanner message={error} />}

      {loading && cards.length === 0 && !editing ? <Spinner label="加载卡片" /> : (
        <div className="master-detail">
          <div className="master-list">
            {cards.length === 0 ? <div className="card-meta" style={{ padding: 12 }}>暂无卡片</div> : cards.map((card) => (
              <button
                key={card.key}
                className="master-item"
                data-active={card.key === selectedKey}
                onClick={() => void select(card.key)}
              >
                <strong>{card.title}</strong>
                <span className="card-meta">{card.summary}</span>
              </button>
            ))}
          </div>

          <div className="detail">
            {editing ? (
              <CardForm
                initial={selected}
                initialSections={sections.map((s) => ({ title: s.title ?? s.section ?? "", body: s.body }))}
                busy={busy}
                client={client}
                onDone={async () => { setEditing(false); await loadList(); }}
                onNotify={notify}
                setBusy={setBusy}
              />
            ) : selected === null ? (
              <EmptyState title="选择一张卡片" description="左侧选择卡片查看分区内容，或新建一张。" />
            ) : (
              <Card>
                <div className="card-head">
                  <strong>{selected.title}</strong>
                  <Badge>{selected.key}</Badge>
                </div>
                <div className="card-body">{selected.summary}</div>
                {sections.length === 0 ? (
                  <div className="card-meta">暂无分区</div>
                ) : sections.map((section, index) => (
                  <div className="card-excerpt" key={section.id ?? index}>
                    <strong>{section.title ?? section.section}</strong>{"\n"}{section.body}
                  </div>
                ))}
                <div className="card-actions" style={{ marginTop: 12 }}>
                  <Button onClick={() => setEditing(true)}>编辑</Button>
                  <Button variant="danger" onClick={() => void remove(selected.key)}>删除</Button>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
      {toast !== null && <Toast message={toast} />}
    </div>
  );
}

function CardForm({
  initial, initialSections, busy, client, onDone, onNotify, setBusy,
}: {
  initial: CardSummary | null;
  initialSections: readonly DraftSection[];
  busy: boolean;
  client: ProfileApi;
  onDone: () => Promise<void>;
  onNotify: (message: string) => void;
  setBusy: (value: boolean) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [sections, setSections] = useState<DraftSection[]>(
    initialSections.length > 0 ? [...initialSections] : [{ title: "", body: "" }],
  );

  const save = async () => {
    if (!title.trim() || !summary.trim()) { onNotify("标题与摘要不能为空"); return; }
    const key = initial?.key ?? title.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "");
    if (!key) { onNotify("无法从标题生成合法 key"); return; }
    const payload = {
      title: title.trim(),
      summary: summary.trim(),
      section_tags: [] as string[],
      sections: sections
        .filter((section) => section.title.trim() && section.body.trim())
        .map((section) => ({ title: section.title.trim(), body: section.body.trim() })),
    };
    setBusy(true);
    try {
      await client.saveCard(key, payload);
      onNotify("已保存");
      await onDone();
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="form-grid">
        <label>标题<input className="textarea form-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="卡片标题" /></label>
        <label>摘要<textarea className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="卡片摘要" /></label>
      </div>
      <h2 className="group-title">分区</h2>
      {sections.map((section, index) => (
        <div className="form-grid" key={index}>
          <label>小节标题<input className="textarea form-input" value={section.title} onChange={(e) => setSections((list) => list.map((s, i) => i === index ? { ...s, title: e.target.value } : s))} aria-label={`小节标题 ${index + 1}`} /></label>
          <label>正文<textarea className="textarea" value={section.body} onChange={(e) => setSections((list) => list.map((s, i) => i === index ? { ...s, body: e.target.value } : s))} aria-label={`小节正文 ${index + 1}`} /></label>
        </div>
      ))}
      <div className="card-actions" style={{ marginTop: 10 }}>
        <Button onClick={() => setSections((list) => [...list, { title: "", body: "" }])}>添加分区</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>保存卡片</Button>
      </div>
    </Card>
  );
}
