/**
 * 微信协助区：默认只生成草稿，发送必须经过显式确认。
 *
 * 该组件只依赖 `WechatAssistPort`，因此不会把 REST、React 或 dsh 细节带入领域层；
 * 生产路径默认使用同源 REST port，测试和宿主装配可以注入替代端口。
 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  createRestWechatAssistPort,
  type WechatAssistDraft,
  type WechatAssistPort,
  type WechatReplyContact,
  type WechatReplyProvider,
  type WechatReplyTask,
} from "./wechat-assist-port.js";
import { InfoField, PANEL_COLORS, WRAP_TEXT } from "./panel-states.js";
import { RADIUS, SPACE } from "./ui-tokens.js";

export interface WechatAssistSectionProps {
  port?: WechatAssistPort;
}

const STATUS_LABELS: Readonly<Record<WechatAssistDraft["status"], string>> = {
  draft: "草稿",
  sent: "已发送",
  discarded: "已丢弃",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  starting: "启动中", running: "运行中", stopping: "停止中", stopped: "已停止", paused: "已暂停", failed: "失败",
};

const DEFAULT_PORT = createRestWechatAssistPort();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WechatAssistSection({ port = DEFAULT_PORT }: WechatAssistSectionProps): ReactElement {
  const [drafts, setDrafts] = useState<WechatAssistDraft[]>([]);
  const [contactId, setContactId] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<WechatReplyContact[]>([]);
  const [providers, setProviders] = useState<WechatReplyProvider[]>([]);
  const [tasks, setTasks] = useState<WechatReplyTask[]>([]);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [objective, setObjective] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [historyAuthorized, setHistoryAuthorized] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);

  const loadDrafts = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDrafts(await port.listDrafts());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDrafts();
    void Promise.all([port.listReplyContacts(), port.listReplyProviders(), port.listReplyTasks()])
      .then(([nextContacts, nextProviders, nextTasks]) => {
        setContacts(nextContacts);
        setProviders(nextProviders);
        setTasks(nextTasks);
        if (nextContacts[0]) setSelectedConversation(nextContacts[0].conversation_id);
        if (nextProviders[0]) {
          setProviderId(nextProviders[0].id);
          setModelId(nextProviders[0].model);
        }
      })
      .catch((err: unknown) => setError(errorMessage(err)));
    // The port is an injected capability; callers should keep it stable for the panel lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  const selectedContact = contacts.find((item) => item.conversation_id === selectedConversation);

  const startReplyTask = async (): Promise<void> => {
    if (!selectedContact || objective.trim() === "") {
      setError("请选择好友并填写聊天目标");
      return;
    }
    setTaskBusy(true);
    setError(null);
    try {
      const task = await port.startReplyTask({
        conversation_id: selectedContact.conversation_id,
        contact_id: selectedContact.contact_id,
        objective: objective.trim(),
        ...(providerId === "" ? {} : { provider_id: providerId }),
        ...(modelId.trim() === "" ? {} : { model_id: modelId.trim() }),
        history_authorized: historyAuthorized,
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    } catch (err) {
      setError(errorMessage(err));
      try { setTasks(await port.listReplyTasks()); } catch { /* retain the last visible task state */ }
    } finally {
      setTaskBusy(false);
    }
  };

  const stopReplyTask = async (id: string): Promise<void> => {
    setTaskBusy(true);
    setError(null);
    try {
      const stopped = await port.stopReplyTask(id);
      setTasks((current) => current.map((item) => item.id === id ? stopped : item));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTaskBusy(false);
    }
  };

  const createDraft = async (): Promise<void> => {
    const nextContactId = contactId.trim();
    const nextBody = body.trim();
    if (nextContactId === "" || nextBody === "") {
      setError("请填写聊天目标和消息正文");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const draft = await port.createDraft({ contact_id: nextContactId, body: nextBody });
      setDrafts((current) => [draft, ...current]);
      setBody("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discardDraft = async (id: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      const updated = await port.discardDraft(id);
      setDrafts((current) => current.map((draft) => (draft.id === id ? updated : draft)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendDraft = async (draft: WechatAssistDraft): Promise<void> => {
    if (!window.confirm(`确认发送给「${draft.contact_id}」吗？`)) return;
    setBusy(draft.id);
    setError(null);
    try {
      const updated = await port.sendDraft(draft.id);
      setDrafts((current) => current.map((item) => (item.id === draft.id ? updated : item)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      data-testid="wechat-assist-section"
      aria-labelledby="wechat-assist-heading"
      style={{
        margin: `0 16px ${SPACE.sm}px`,
        padding: SPACE.md,
        border: `1px solid ${PANEL_COLORS.border}`,
        borderRadius: RADIUS.card,
        background: PANEL_COLORS.subtleBg,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: SPACE.sm }}>
        <h3 id="wechat-assist-heading" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          微信协助
        </h3>
        <span style={{ fontSize: 11, color: PANEL_COLORS.muted }}>默认保存为草稿</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, marginTop: SPACE.sm }}>
        <div data-testid="wechat-auto-reply" style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, paddingBottom: SPACE.md, borderBottom: `1px solid ${PANEL_COLORS.border}` }}>
          <strong style={{ fontSize: 12 }}>自动回复</strong>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <span style={{ color: PANEL_COLORS.muted }}>好友</span>
            <select aria-label="自动回复好友" value={selectedConversation} onChange={(event) => setSelectedConversation(event.currentTarget.value)} style={{ minHeight: 30, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text }}>
              {contacts.length === 0 && <option value="">没有可用的好友直聊</option>}
              {contacts.map((contact) => <option key={contact.conversation_id} value={contact.conversation_id}>{contact.title} · {contact.index_state === "ready" ? "历史已索引" : "历史索引中"}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <span style={{ color: PANEL_COLORS.muted }}>聊天目标</span>
            <input aria-label="自动回复聊天目标" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="例如：哄好她" style={{ minHeight: 30, padding: "5px 8px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, font: "inherit" }} />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: SPACE.sm }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span style={{ color: PANEL_COLORS.muted }}>Provider</span>
              <select aria-label="自动回复 Provider" value={providerId} onChange={(event) => { const selected = providers.find((item) => item.id === event.currentTarget.value); setProviderId(event.currentTarget.value); if (selected) setModelId(selected.model); }} style={{ minHeight: 30, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text }}>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
              <span style={{ color: PANEL_COLORS.muted }}>Model</span>
              <input aria-label="自动回复 Model" value={modelId} onChange={(event) => setModelId(event.currentTarget.value)} style={{ minHeight: 30, padding: "5px 8px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, font: "inherit" }} />
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, color: PANEL_COLORS.text }}>
            <input type="checkbox" checked={historyAuthorized} onChange={(event) => setHistoryAuthorized(event.currentTarget.checked)} />
            允许将所选好友的相关历史发送给模型
          </label>
          <button type="button" data-testid="wechat-start-auto-reply" disabled={taskBusy || !selectedContact || objective.trim() === ""} onClick={() => void startReplyTask()} style={{ alignSelf: "flex-start", padding: "5px 10px", border: `1px solid ${PANEL_COLORS.accent}`, borderRadius: RADIUS.control, background: PANEL_COLORS.accent, color: "#fff", fontSize: 12, cursor: taskBusy ? "default" : "pointer" }}>启动自动回复</button>
          {tasks.map((task) => (
            <article key={task.id} data-testid={`wechat-reply-task-${task.id}`} style={{ borderTop: `1px solid ${PANEL_COLORS.border}`, paddingTop: SPACE.sm }}>
              <InfoField label="好友 / 目标" value={`${task.contact_id} · ${task.objective}`} />
              <InfoField label="状态" value={`${TASK_STATUS_LABELS[task.status] ?? task.status}${task.stop_reason ? `：${task.stop_reason}` : ""}`} />
              <InfoField label="轮数 / 发送" value={`${task.turn_count} / ${task.send_count}`} />
              {task.status !== "stopped" && <button type="button" data-testid={`wechat-stop-auto-reply-${task.id}`} aria-label="停止自动回复" disabled={taskBusy || task.status === "stopping"} onClick={() => void stopReplyTask(task.id)} style={{ padding: "5px 10px", border: `1px solid ${PANEL_COLORS.dangerText}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.dangerText, fontSize: 12, cursor: taskBusy ? "default" : "pointer" }}>停止自动回复</button>}
            </article>
          ))}
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          <span style={{ color: PANEL_COLORS.muted }}>聊天目标</span>
          <input
            aria-label="聊天目标"
            value={contactId}
            onChange={(event) => setContactId(event.currentTarget.value)}
            placeholder="contact_id"
            style={{
              boxSizing: "border-box",
              width: "100%",
              minHeight: 30,
              padding: "5px 8px",
              border: `1px solid ${PANEL_COLORS.border}`,
              borderRadius: RADIUS.control,
              background: PANEL_COLORS.surface,
              color: PANEL_COLORS.text,
              font: "inherit",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          <span style={{ color: PANEL_COLORS.muted }}>消息正文</span>
          <textarea
            aria-label="消息正文"
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            rows={3}
            placeholder="输入要保存的消息内容"
            style={{
              boxSizing: "border-box",
              width: "100%",
              resize: "vertical",
              padding: "6px 8px",
              border: `1px solid ${PANEL_COLORS.border}`,
              borderRadius: RADIUS.control,
              background: PANEL_COLORS.surface,
              color: PANEL_COLORS.text,
              font: "inherit",
              ...WRAP_TEXT,
            }}
          />
        </label>
        <button
          type="button"
          data-testid="wechat-create-draft"
          disabled={saving}
          onClick={() => void createDraft()}
          style={{
            alignSelf: "flex-start",
            cursor: saving ? "default" : "pointer",
            padding: "5px 10px",
            border: `1px solid ${PANEL_COLORS.accent}`,
            borderRadius: RADIUS.control,
            background: PANEL_COLORS.accent,
            color: "#ffffff",
            fontSize: 12,
          }}
        >
          {saving ? "保存中…" : "生成草稿"}
        </button>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="wechat-assist-error"
          style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}
        >
          微信协助加载失败：{error}
        </p>
      )}

      <div style={{ marginTop: SPACE.md }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>草稿列表</span>
          <button
            type="button"
            aria-label="刷新微信草稿"
            onClick={() => void loadDrafts()}
            disabled={loading}
            style={{
              cursor: loading ? "default" : "pointer",
              border: 0,
              padding: 0,
              background: "transparent",
              color: PANEL_COLORS.accentText,
              fontSize: 12,
            }}
          >
            刷新
          </button>
        </div>
        {loading && <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: `${SPACE.sm}px 0 0` }}>加载中…</p>}
        {!loading && drafts.length === 0 && (
          <p data-testid="wechat-assist-empty" style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: `${SPACE.sm}px 0 0` }}>
            还没有微信草稿。
          </p>
        )}
        {!loading && drafts.length > 0 && (
          <div
            data-testid="wechat-assist-drafts"
            style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, maxHeight: 220, overflowY: "auto", marginTop: SPACE.sm }}
          >
            {drafts.map((draft) => {
              const isBusy = busy === draft.id;
              return (
                <article
                  key={draft.id}
                  data-testid={`wechat-draft-${draft.id}`}
                  style={{ padding: SPACE.sm, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface }}
                >
                  <InfoField label="目标" value={draft.contact_id} />
                  <InfoField label="状态" value={STATUS_LABELS[draft.status]} />
                  <InfoField label="正文" value={draft.body} />
                  {draft.external_id !== null && <InfoField label="外部编号" value={draft.external_id} />}
                  {draft.status === "draft" && (
                    <div style={{ display: "flex", gap: SPACE.sm, marginTop: SPACE.sm }}>
                      <button
                        type="button"
                        data-testid={`wechat-send-${draft.id}`}
                        disabled={isBusy}
                        onClick={() => void sendDraft(draft)}
                        style={{ cursor: isBusy ? "default" : "pointer", padding: "4px 9px", border: `1px solid ${PANEL_COLORS.accent}`, borderRadius: RADIUS.control, background: PANEL_COLORS.accentBg, color: PANEL_COLORS.accentText, fontSize: 12 }}
                      >
                        {isBusy ? "处理中…" : "发送"}
                      </button>
                      <button
                        type="button"
                        data-testid={`wechat-discard-${draft.id}`}
                        disabled={isBusy}
                        onClick={() => void discardDraft(draft.id)}
                        style={{ cursor: isBusy ? "default" : "pointer", padding: "4px 9px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, fontSize: 12 }}
                      >
                        丢弃
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
