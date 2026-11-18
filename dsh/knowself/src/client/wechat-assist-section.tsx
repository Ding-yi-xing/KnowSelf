/** 微信协助：受限自动回复任务。模型由 dsh 当前聊天配置在服务端解析。 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  createRestWechatAssistPort,
  type WechatAssistPort,
  type WechatReplyContact,
  type WechatReplyPersona,
  type WechatReplyTask,
  type WechatTransportCapabilities,
  type WechatModelCatalog,
} from "./wechat-assist-port.js";
import { InfoField, PANEL_COLORS, WRAP_TEXT } from "./panel-states.js";
import { ConfirmDialog } from "./modal.js";
import { RADIUS, SPACE } from "./ui-tokens.js";

export interface WechatAssistSectionProps { port?: WechatAssistPort; }

const DEFAULT_PORT = createRestWechatAssistPort();
const TASK_STATUS_LABELS: Record<string, string> = { starting: "启动中", running: "运行中", stopping: "停止中", stopped: "已停止", paused: "已暂停", failed: "失败" };
const REQUIRED_CAPABILITIES: ReadonlyArray<[keyof WechatTransportCapabilities, string]> = [
  ["can_inspect_conversation", "读取当前会话"], ["can_list_unread", "监听未读消息"], ["can_send", "发送消息"], ["can_lookup_send_result", "查询发送回执"],
];
const controlStyle = { minHeight: 30, padding: "5px 8px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, font: "inherit" } as const;

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function WechatAssistSection({ port = DEFAULT_PORT }: WechatAssistSectionProps): ReactElement {
  const [contacts, setContacts] = useState<WechatReplyContact[]>([]);
  const [tasks, setTasks] = useState<WechatReplyTask[]>([]);
  const [transport, setTransport] = useState<WechatTransportCapabilities | null>(null);
  const [selectedConversation, setSelectedConversation] = useState("");
  const [objective, setObjective] = useState("");
  const [historyAuthorized, setHistoryAuthorized] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: string; kind: "stop" | "revoke" } | null>(null);
  const [personas, setPersonas] = useState<Record<string, WechatReplyPersona>>({});
  const [modelCatalog, setModelCatalog] = useState<WechatModelCatalog | null>(null);
  const [modelKey, setModelKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    const refresh = async (initial = false): Promise<void> => {
      try {
        const [nextContacts, nextTasks, nextTransport, nextModels] = await Promise.all([
          initial ? port.listReplyContacts() : Promise.resolve(contacts),
          port.listReplyTasks(),
          port.getTransportCapabilities(),
          port.getReplyModels(),
        ]);
        if (cancelled) return;
        if (initial) {
          setContacts(nextContacts);
          setSelectedConversation((current) => current || nextContacts[0]?.conversation_id || "");
        }
        setTasks(nextTasks); setTransport(nextTransport); setModelCatalog(nextModels);
        setModelKey((current) => {
          if (current !== "") return current;
          const preferred = nextModels.current ?? nextModels.models[0];
          return preferred === undefined ? "" : `${preferred.provider}::${preferred.model}`;
        });
        for (const task of nextTasks) {
          if (task.status !== "running" && task.status !== "paused") continue;
          void port.getReplyPersona(task.id).then((persona) => {
            if (persona === null) return;
            setPersonas((current) => current[task.id] === undefined ? { ...current, [task.id]: persona } : current);
          }).catch(() => {});
        }
      } catch (reason) { if (!cancelled) setError(errorMessage(reason)); }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(false), 3000);
    return () => { cancelled = true; clearInterval(timer); };
    // The injected port is stable for the panel lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  const selectedContact = contacts.find((item) => item.conversation_id === selectedConversation);
  const missingCapabilities = transport === null ? ["正在检查微信桌面能力"] : REQUIRED_CAPABILITIES.filter(([key]) => transport[key] !== true).map(([, label]) => label);
  const canStart = transport?.available === true && missingCapabilities.length === 0;

  const start = async (): Promise<void> => {
    if (!selectedContact || objective.trim() === "" || !canStart) {
      setError(!canStart ? "微信桌面能力未就绪，暂不能启动自动回复" : "请选择好友并填写聊天目标");
      return;
    }
    setTaskBusy(true); setError(null);
    try {
      const [providerId, modelId] = modelKey.split("::");
      const task = await port.startReplyTask({
        conversation_id: selectedContact.conversation_id,
        contact_id: selectedContact.contact_id,
        objective: objective.trim(),
        history_authorized: historyAuthorized,
        ...(providerId !== undefined && providerId !== "" && modelId !== undefined && modelId !== ""
          ? { provider_id: providerId, model_id: modelId }
          : {}),
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
    } catch (reason) { setError(errorMessage(reason)); } finally { setTaskBusy(false); }
  };

  const stop = async (id: string): Promise<void> => {
    setTaskBusy(true); setError(null);
    try { const next = await port.stopReplyTask(id); setTasks((current) => current.map((item) => item.id === id ? next : item)); }
    catch (reason) { setError(errorMessage(reason)); } finally { setTaskBusy(false); }
  };

  const revokeHistory = async (id: string): Promise<void> => {
    setTaskBusy(true); setError(null);
    try { const next = await port.revokeReplyTaskHistory(id); setTasks((current) => current.map((item) => item.id === id ? next : item)); }
    catch (reason) { setError(errorMessage(reason)); } finally { setTaskBusy(false); }
  };

  return <section data-testid="wechat-assist-section" aria-labelledby="wechat-assist-heading" style={{ margin: 0, padding: SPACE.lg, border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.card, background: PANEL_COLORS.subtleBg, flexShrink: 0 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}><h2 id="wechat-assist-heading" style={{ margin: 0, fontSize: 15 }}>微信协助</h2></div>
    {transport !== null && !canStart && <p data-testid="wechat-transport-blocked" style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}>自动回复当前不可用：{transport.reason || `缺少${missingCapabilities.join("、")}`}</p>}
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
      <label style={labelStyle}><span>好友</span><select aria-label="自动回复好友" value={selectedConversation} onChange={(event) => setSelectedConversation(event.currentTarget.value)} style={controlStyle}>{contacts.length === 0 ? <option value="">没有可用好友</option> : contacts.map((contact) => <option key={contact.conversation_id} value={contact.conversation_id}>{contact.title || contact.contact_id}</option>)}</select></label>
      {selectedContact && <InfoField label="聊天记录" value={selectedContact.index_state === "ready" ? "历史已索引" : `索引状态：${selectedContact.index_state}`} />}
      <label style={labelStyle}><span>聊天目标</span><textarea aria-label="自动回复聊天目标" value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="例如：哄好她，保持真诚、简短" style={{ ...controlStyle, minHeight: 68, resize: "vertical" }} /></label>
      <label style={labelStyle}><span>模型</span><select aria-label="回复模型" value={modelKey} onChange={(event) => setModelKey(event.currentTarget.value)} disabled={modelCatalog === null || modelCatalog.models.length === 0} style={controlStyle}>{modelCatalog === null || modelCatalog.models.length === 0 ? <option value="">dsh 未配置模型</option> : modelCatalog.models.map((item) => <option key={`${item.provider}::${item.model}`} value={`${item.provider}::${item.model}`}>{item.label}</option>)}</select></label>
      <p style={{ margin: 0, fontSize: 12, color: PANEL_COLORS.muted, ...WRAP_TEXT }}>只列出 dsh 已配置的模型；本次选择只影响新任务。</p>
      <label style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, color: PANEL_COLORS.text }}><input type="checkbox" checked={historyAuthorized} onChange={(event) => setHistoryAuthorized(event.currentTarget.checked)} />允许将所选好友的相关历史发送给模型</label>
      <button type="button" data-testid="wechat-start-auto-reply" disabled={taskBusy || !selectedContact || objective.trim() === "" || !canStart} onClick={() => void start()} style={primaryButton}>启动自动回复</button>
    </div>
    {error !== null && <p role="alert" data-testid="wechat-assist-error" style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}>微信协助加载失败：{error}</p>}
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, marginTop: SPACE.md }}>
      {tasks.map((task) => <article key={task.id} data-testid={`wechat-reply-task-${task.id}`} style={{ borderTop: `1px solid ${PANEL_COLORS.border}`, paddingTop: SPACE.sm }}><InfoField label="好友 / 目标" value={`${task.contact_id} · ${task.objective}`} /><InfoField label="状态" value={`${TASK_STATUS_LABELS[task.status] ?? task.status}${task.stop_reason ? `：${task.stop_reason}` : ""}`} /><InfoField label="轮数 / 发送" value={`${task.turn_count} / ${task.send_count}`} />{personas[task.id] && <InfoField label="对方画像" value={personaLine(personas[task.id])} />}<div style={{ display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>{task.history_authorized && <button type="button" data-testid={`wechat-revoke-history-${task.id}`} disabled={taskBusy} onClick={() => setConfirmAction({ id: task.id, kind: "revoke" })} style={secondaryButton}>撤销历史授权并暂停</button>}{task.status !== "stopped" && <button type="button" data-testid={`wechat-stop-auto-reply-${task.id}`} aria-label="停止自动回复" disabled={taskBusy || task.status === "stopping"} onClick={() => setConfirmAction({ id: task.id, kind: "stop" })} style={dangerButton}>停止自动回复</button>}</div></article>)}
    </div>
    <ConfirmDialog
      open={confirmAction !== null}
      title={confirmAction?.kind === "revoke" ? "撤销历史授权" : "停止自动回复"}
      danger
      busy={taskBusy}
      message={
        confirmAction?.kind === "revoke"
          ? "撤销后该任务会立即暂停，模型不能再读取所选好友的历史。确认撤销？"
          : "停止后当前任务会中断，已发送的消息不会撤回。确认停止？"
      }
      confirmLabel={confirmAction?.kind === "revoke" ? "确认撤销" : "确认停止"}
      onCancel={() => setConfirmAction(null)}
      onConfirm={() => {
        const pending = confirmAction;
        if (pending === null) return;
        setConfirmAction(null);
        if (pending.kind === "revoke") void revokeHistory(pending.id);
        else void stop(pending.id);
      }}
      testId="wechat-task-confirm-dialog"
      confirmTestId="wechat-task-confirm"
    />
  </section>;
}

function personaLine(persona: WechatReplyPersona | undefined): string {
  if (persona === undefined) return "画像生成中";
  const parts = [persona.target.summary, persona.target.traits.join("、"), persona.target.psychology[0] ?? ""]
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return parts.length === 0 ? "画像生成中" : parts.join("｜");
}

const labelStyle = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: PANEL_COLORS.muted } as const;const primaryButton = { alignSelf: "flex-start", padding: "5px 10px", border: `1px solid ${PANEL_COLORS.accent}`, borderRadius: RADIUS.control, background: PANEL_COLORS.accent, color: "#fff", fontSize: 12, cursor: "pointer" } as const;
const secondaryButton = { padding: "5px 10px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: RADIUS.control, background: PANEL_COLORS.surface, color: PANEL_COLORS.text, fontSize: 12, cursor: "pointer" } as const;
const dangerButton = { ...secondaryButton, border: `1px solid ${PANEL_COLORS.dangerText}`, color: PANEL_COLORS.dangerText } as const;
