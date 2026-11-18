/** 画像面板：核心画像与主题卡片的读取和人工维护入口。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type {
  CardInput,
  CardSummary,
  CardWithSections,
  CoreProfileInput,
  CoreProfileStored,
} from "@knowself/contracts";
import {
  DegradedError,
  SessionExpiredError,
  type KnowselfProfilePort,
} from "./profile-port.js";
import {
  DegradedNotice,
  EmptyNotice,
  ErrorNotice,
  InfoField,
  LoadingNotice,
  PANEL_COLORS,
  SessionExpiredNotice,
  TagChips,
  WRAP_TEXT,
} from "./panel-states.js";
import { PanelHeading, PanelShell, useContainerWidth } from "./ui-kit.js";
import { ConfirmDialog } from "./modal.js";
import { RADIUS, SPACE } from "./ui-tokens.js";

export interface ProfilePanelViewProps {
  port: KnowselfProfilePort;
}

type Selection = { kind: "core" } | { kind: "card"; key: string };
type Editor = "core" | "card" | "new" | null;
type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };
type CardDraft = {
  key: string;
  title: string;
  summary: string;
  tags: string;
  sections: Array<{ title: string; body: string }>;
};

const EMPTY_CARD: CardDraft = { key: "", title: "", summary: "", tags: "", sections: [{ title: "", body: "" }] };

function splitTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function failureFrom(error: unknown): PanelFailure {
  if (error instanceof SessionExpiredError) return { kind: "session" };
  if (error instanceof DegradedError) return { kind: "degraded", reason: error.reason };
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}

function cardDraftFrom(detail: CardWithSections): CardDraft {
  return {
    key: detail.card.key,
    title: detail.card.title,
    summary: detail.card.summary,
    tags: detail.card.section_tags.join(", "),
    sections: detail.sections.map(({ title, body }) => ({ title, body })),
  };
}

export function ProfilePanelView({ port }: ProfilePanelViewProps): ReactElement {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const narrow = useContainerWidth(layoutRef) < 640;
  const [core, setCore] = useState<CoreProfileStored | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "core" });
  const [detail, setDetail] = useState<CardWithSections | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [editor, setEditor] = useState<Editor>(null);
  const [coreDraft, setCoreDraft] = useState<CoreProfileInput>({ body: "" });
  const [cardDraft, setCardDraft] = useState<CardDraft>(EMPTY_CARD);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([port.getProfileCore(), port.listCards()]).then(([nextCore, nextCards]) => {
      if (cancelled) return;
      setCore(nextCore);
      setCards(nextCards);
      setFailure(null);
    }).catch((error: unknown) => {
      if (!cancelled) setFailure(failureFrom(error));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [port, reloadToken]);

  useEffect(() => {
    if (selection.kind !== "card") {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    void port.getCard(selection.key).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch((error: unknown) => {
      if (!cancelled) setFailure(failureFrom(error));
    });
    return () => { cancelled = true; };
  }, [port, selection, reloadToken]);

  const startCoreEdit = (): void => {
    if (core === null) return;
    setCoreDraft({ body: core.body, display_name: core.display_name || undefined, locale: core.locale || undefined, section_tags: core.section_tags });
    setEditor("core");
  };

  const startCardEdit = (): void => {
    if (detail === null) return;
    setCardDraft(cardDraftFrom(detail));
    setEditor("card");
  };

  const saveCore = async (): Promise<void> => {
    setSaving(true); setFailure(null);
    try {
      const saved = await port.saveProfileCore({
        body: coreDraft.body,
        ...(coreDraft.display_name?.trim() ? { display_name: coreDraft.display_name.trim() } : {}),
        ...(coreDraft.locale?.trim() ? { locale: coreDraft.locale.trim() } : {}),
        section_tags: coreDraft.section_tags ?? [],
      });
      setCore(saved); setEditor(null);
    } catch (error) { setFailure(failureFrom(error)); } finally { setSaving(false); }
  };

  const saveCard = async (): Promise<void> => {
    const input: CardInput = {
      key: cardDraft.key.trim(),
      title: cardDraft.title.trim(),
      summary: cardDraft.summary.trim(),
      section_tags: splitTags(cardDraft.tags),
      sections: cardDraft.sections.map((section) => ({ title: section.title.trim(), body: section.body })),
    };
    if (!input.key || !input.title || !input.summary || input.sections.some((section) => !section.title)) {
      setFailure({ kind: "error", message: "请填写卡片 key、标题、摘要和每个分节标题" });
      return;
    }
    setSaving(true); setFailure(null);
    try {
      const saved = editor === "new" ? await port.createCard(input) : await port.saveCard(input.key, input);
      setCards(await port.listCards());
      setDetail(saved); setSelection({ kind: "card", key: saved.card.key }); setEditor(null);
    } catch (error) { setFailure(failureFrom(error)); } finally { setSaving(false); }
  };

  const deleteCard = async (): Promise<void> => {
    if (selection.kind !== "card") return;
    setSaving(true); setFailure(null);
    try {
      await port.deleteCard(selection.key);
      setCards(await port.listCards()); setSelection({ kind: "core" }); setEditor(null);
    } catch (error) { setFailure(failureFrom(error)); } finally { setSaving(false); }
  };

  const failureView = failure?.kind === "degraded"
    ? <DegradedNotice reason={failure.reason} onRetry={reload} testId="profile-panel-degraded" />
    : failure?.kind === "session"
      ? <SessionExpiredNotice testId="profile-panel-session-expired" />
      : failure?.kind === "error"
        ? <ErrorNotice message={`数据读取失败：${failure.message}`} testId="profile-panel-error" />
        : null;

  return (
    <div ref={layoutRef} style={{ height: "100%" }}>
    <PanelShell testId="profile-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHeading title="核心画像与主题卡片" />
      {failureView ?? (loading ? <LoadingNotice text="加载画像中…" /> : (
        <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", minHeight: 0, flex: 1, gap: SPACE.md }}>
          <aside aria-label="画像目录" style={{ width: narrow ? "100%" : 206, flexShrink: 0, display: "flex", flexDirection: "column", gap: SPACE.sm }}>
            <div style={GROUP_TITLE}>L1 · 核心画像</div>
            <button type="button" onClick={() => { setSelection({ kind: "core" }); setEditor(null); }} style={itemStyle(selection.kind === "core")}>核心画像</button>
            <div style={GROUP_TITLE}>L2 · 主题卡片</div>
            {cards.map((card) => <button key={card.key} type="button" onClick={() => { setSelection({ kind: "card", key: card.key }); setEditor(null); }} style={itemStyle(selection.kind === "card" && selection.key === card.key)}>{card.title || card.key}</button>)}
            <button type="button" data-testid="profile-create-card" onClick={() => { setCardDraft({ ...EMPTY_CARD, sections: [{ title: "", body: "" }] }); setEditor("new"); }} style={secondaryButton}>新建主题卡片</button>
          </aside>
          <section aria-label="画像详情" style={{ flex: 1, minWidth: 0, padding: SPACE.md, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.card, background: PANEL_COLORS.surface }}>
            {editor === "core" ? <CoreEditor draft={coreDraft} saving={saving} onChange={setCoreDraft} onSave={() => void saveCore()} onCancel={() => setEditor(null)} />
              : editor === "card" || editor === "new" ? <CardEditor draft={cardDraft} isNew={editor === "new"} saving={saving} onChange={setCardDraft} onSave={() => void saveCard()} onCancel={() => setEditor(null)} />
                : selection.kind === "core" ? <CoreDetail core={core} onEdit={startCoreEdit} />
                  : <CardDetail detail={detail} cardKey={selection.key} onEdit={startCardEdit} onDelete={() => setConfirmDelete(true)} deleting={saving} />}
          </section>
        </div>
      ))}
    </PanelShell>
    <ConfirmDialog
      open={confirmDelete}
      title="删除主题卡片"
      danger
      busy={saving}
      message={
        selection.kind === "card"
          ? <>删除主题卡片「{detail?.card.title || selection.key}」？该卡片的分节内容会一并删除，<strong>不可撤销</strong>。</>
          : "删除主题卡片？此操作不可撤销。"
      }
      confirmLabel="确认删除"
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => {
        void deleteCard().finally(() => setConfirmDelete(false));
      }}
      testId="profile-delete-dialog"
      confirmTestId="profile-delete-confirm"
    />
    </div>
  );
}

function CoreDetail({ core, onEdit }: { core: CoreProfileStored | null; onEdit: () => void }): ReactElement {
  if (core === null) return <EmptyNotice text="暂无核心画像数据。" />;
  return <><ActionRow><button type="button" data-testid="profile-edit-core" onClick={onEdit} style={primaryButton}>编辑核心画像</button></ActionRow><h2 style={TITLE}>{core.display_name || "（未命名）"}</h2><InfoField label="显示名" value={core.display_name} /><InfoField label="语言" value={core.locale} /><InfoField label="分区标签" value={<TagChips tags={core.section_tags} />} /><InfoField label="更新时间" value={core.updated_at} /><h3 style={SECTION_TITLE}>正文</h3><div data-testid="profile-core-body" style={bodyStyle}>{core.body || "—"}</div></>;
}

function CardDetail({ detail, cardKey, onEdit, onDelete, deleting }: { detail: CardWithSections | null; cardKey: string; onEdit: () => void; onDelete: () => void; deleting: boolean }): ReactElement {
  if (detail === null) return <LoadingNotice text="读取卡片中…" />;
  return <><ActionRow><button type="button" data-testid="profile-edit-card" onClick={onEdit} style={primaryButton}>编辑</button><button type="button" data-testid="profile-delete-card" onClick={onDelete} disabled={deleting} style={dangerButton}>删除</button></ActionRow><h2 style={TITLE}>{detail.card.title || cardKey}</h2><InfoField label="key" value={detail.card.key} /><InfoField label="摘要" value={detail.card.summary} /><InfoField label="分区标签" value={<TagChips tags={detail.card.section_tags} />} /><InfoField label="更新时间" value={detail.card.updated_at} /><h3 style={SECTION_TITLE}>分节（{detail.sections.length}）</h3>{detail.sections.length === 0 ? <EmptyNotice text="这张卡片还没有分节内容。" /> : detail.sections.map((section) => <article key={section.id} style={{ marginBottom: SPACE.md }}><h4 style={SUBTITLE}>{section.title}</h4><div style={bodyStyle}>{section.body || "—"}</div></article>)}</>;
}

function CoreEditor({ draft, saving, onChange, onSave, onCancel }: { draft: CoreProfileInput; saving: boolean; onChange: (value: CoreProfileInput) => void; onSave: () => void; onCancel: () => void }): ReactElement {
  return <><h2 style={TITLE}>编辑核心画像</h2><Field label="显示名" value={draft.display_name ?? ""} onChange={(display_name) => onChange({ ...draft, display_name })} /><Field label="语言" value={draft.locale ?? ""} placeholder="zh-CN" onChange={(locale) => onChange({ ...draft, locale })} /><Field label="分区标签（逗号分隔）" value={(draft.section_tags ?? []).join(", ")} onChange={(tags) => onChange({ ...draft, section_tags: splitTags(tags) })} /><TextArea label="正文" value={draft.body} onChange={(body) => onChange({ ...draft, body })} /><ActionRow><button type="button" data-testid="profile-save-core" disabled={saving} onClick={onSave} style={primaryButton}>{saving ? "保存中…" : "保存"}</button><button type="button" onClick={onCancel} style={secondaryButton}>取消</button></ActionRow></>;
}

function CardEditor({ draft, isNew, saving, onChange, onSave, onCancel }: { draft: CardDraft; isNew: boolean; saving: boolean; onChange: (value: CardDraft) => void; onSave: () => void; onCancel: () => void }): ReactElement {
  const updateSection = (index: number, key: "title" | "body", value: string): void => onChange({ ...draft, sections: draft.sections.map((section, current) => current === index ? { ...section, [key]: value } : section) });
  return <><h2 style={TITLE}>{isNew ? "新建主题卡片" : "编辑主题卡片"}</h2><Field label="Key" value={draft.key} disabled={!isNew} onChange={(key) => onChange({ ...draft, key })} /><Field label="标题" value={draft.title} onChange={(title) => onChange({ ...draft, title })} /><TextArea label="摘要" value={draft.summary} onChange={(summary) => onChange({ ...draft, summary })} /><Field label="分区标签（逗号分隔）" value={draft.tags} onChange={(tags) => onChange({ ...draft, tags })} /><h3 style={SECTION_TITLE}>分节</h3>{draft.sections.map((section, index) => <div key={index} style={{ borderTop: `1px solid ${PANEL_COLORS.border}`, paddingTop: SPACE.sm, marginTop: SPACE.sm }}><Field label={`分节 ${index + 1} 标题`} value={section.title} onChange={(value) => updateSection(index, "title", value)} /><TextArea label={`分节 ${index + 1} 正文`} value={section.body} onChange={(value) => updateSection(index, "body", value)} />{draft.sections.length > 1 && <button type="button" onClick={() => onChange({ ...draft, sections: draft.sections.filter((_, current) => current !== index) })} style={secondaryButton}>删除分节</button>}</div>)}<button type="button" onClick={() => onChange({ ...draft, sections: [...draft.sections, { title: "", body: "" }] })} style={secondaryButton}>添加分节</button><ActionRow><button type="button" data-testid="profile-save-card" disabled={saving} onClick={onSave} style={primaryButton}>{saving ? "保存中…" : "保存"}</button><button type="button" onClick={onCancel} style={secondaryButton}>取消</button></ActionRow></>;
}

function ActionRow({ children }: { children: ReactNode }): ReactElement { return <div style={{ display: "flex", justifyContent: "flex-end", gap: SPACE.sm, marginBottom: SPACE.md }}>{children}</div>; }
function Field({ label, value, onChange, placeholder, disabled = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }): ReactElement { return <label style={labelStyle}><span>{label}</span><input aria-label={label} value={value} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} style={inputStyle} /></label>; }
function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): ReactElement { return <label style={labelStyle}><span>{label}</span><textarea aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} style={{ ...inputStyle, minHeight: 90, resize: "vertical" }} /></label>; }

const GROUP_TITLE = { fontSize: 12, fontWeight: 600, color: PANEL_COLORS.muted, marginTop: SPACE.sm } as const;
const TITLE = { fontSize: 17, margin: "0 0 12px", ...WRAP_TEXT } as const;
const SUBTITLE = { fontSize: 13, margin: "0 0 4px", ...WRAP_TEXT } as const;
const SECTION_TITLE = { fontSize: 14, margin: "20px 0 8px" } as const;
const bodyStyle = { fontSize: 13, lineHeight: 1.7, background: PANEL_COLORS.subtleBg, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: 6, padding: 10, ...WRAP_TEXT } as const;
const labelStyle = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, marginBottom: SPACE.sm, color: PANEL_COLORS.muted } as const;
const inputStyle = { boxSizing: "border-box", width: "100%", minHeight: 30, padding: "5px 8px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, font: "inherit" } as const;
const primaryButton = { padding: "5px 10px", border: `1px solid ${PANEL_COLORS.accent}`, borderRadius: RADIUS.control, background: PANEL_COLORS.accent, color: "#fff", fontSize: 12, cursor: "pointer" } as const;
const secondaryButton = { padding: "5px 10px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, fontSize: 12, cursor: "pointer" } as const;
const dangerButton = { ...secondaryButton, border: `1px solid ${PANEL_COLORS.dangerText}`, color: PANEL_COLORS.dangerText } as const;
function itemStyle(active: boolean) { return { width: "100%", textAlign: "left" as const, cursor: "pointer", border: `1px solid ${active ? PANEL_COLORS.accent : PANEL_COLORS.border}`, background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface, borderRadius: RADIUS.control, padding: "10px 12px", color: PANEL_COLORS.text }; }
