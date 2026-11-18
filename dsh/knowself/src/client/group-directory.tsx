/**
 * 人物档案里的「群聊」页签：群列表 + 群消息时间线。
 *
 * 群聊与联系人直聊分开统计/展示：联系人目录只看 `direct_only` 的直聊消息，
 * 群消息在这里按 `conversation_id` 单列，避免把好友在群里发的消息混进个人档案。
 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type {
  PersonPanelDataPort,
  PersonPanelGroup,
  PersonPanelGroupMessage,
} from "./data-port.js";
import { EmptyState, SkeletonList } from "./ui-kit.js";
import { PersonLayerDegradedError } from "./rest-data-port.js";
import { COLORS, RADIUS, SPACE, TABULAR, TYPE } from "./ui-tokens.js";

export interface GroupDirectoryViewProps {
  port: PersonPanelDataPort;
}

const LIST_LIMIT = 200;
const TIMELINE_LIMIT = 60;

function formatWhen(iso: string | null): string {
  if (iso === null || iso === "") return "无消息";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function GroupDirectoryView({ port }: GroupDirectoryViewProps): ReactElement {
  const [groups, setGroups] = useState<PersonPanelGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PersonPanelGroupMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      setDegraded(null);
      try {
        const rows = port.listGroups === undefined ? [] : await Promise.resolve(port.listGroups({ limit: LIST_LIMIT }));
        if (!cancelled) setGroups(rows);
      } catch (reason) {
        if (!cancelled) {
          if (reason instanceof PersonLayerDegradedError) setDegraded(reason.reason);
          else setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken]);

  useEffect(() => {
    if (selectedId === null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = port.groupTimeline === undefined ? [] : await Promise.resolve(port.groupTimeline(selectedId, { limit: TIMELINE_LIMIT }));
        if (!cancelled) setMessages(rows);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, selectedId]);

  const selected = groups.find((group) => group.conversation_id === selectedId) ?? null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 0.56fr)",
        overflow: "hidden",
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.card,
        background: COLORS.surface,
      }}
    >
      <div style={{ minHeight: 0, overflowY: "auto", height: "100%", padding: SPACE.md }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: SPACE.md, padding: `${SPACE.xs}px ${SPACE.sm}px ${SPACE.md}px` }}>
          <div style={{ ...TYPE.section }}>群聊目录</div>
          <span style={{ ...TYPE.meta, color: COLORS.subtle }}>{groups.length} 个群</span>
        </div>
        {loading && <SkeletonList rows={6} testId="group-loading" />}
        {degraded !== null && (
          <div role="alert" data-testid="group-layer-degraded" style={{ fontSize: 12, color: COLORS.warnText, background: COLORS.warnBg, border: `1px solid ${COLORS.warnBorder}`, borderRadius: RADIUS.control, padding: SPACE.sm, marginBottom: SPACE.sm }}>
            数据层未就绪：{degraded}
            <button type="button" onClick={() => setReloadToken((n) => n + 1)} style={{ marginLeft: SPACE.sm, cursor: "pointer" }}>重试</button>
          </div>
        )}
        {error !== null && <p role="alert" style={{ fontSize: 12, color: COLORS.danger }}>群聊读取失败：{error}</p>}
        {!loading && degraded === null && groups.length === 0 && (
          <EmptyState icon="👥" text="还没有群聊记录。" testId="group-empty" />
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {groups.map((group) => {
            const active = group.conversation_id === selectedId;
            return (
              <li key={group.conversation_id} data-testid="group-row" style={{ marginBottom: SPACE.sm }}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedId(group.conversation_id)}
                  title={group.title || group.conversation_id}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: SPACE.md,
                    padding: SPACE.md,
                    border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                    borderRadius: RADIUS.card,
                    background: active ? COLORS.accentSoft : COLORS.surface,
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 32,
                      height: 32,
                      flexShrink: 0,
                      borderRadius: RADIUS.control,
                      background: COLORS.accentSoft,
                      color: COLORS.accent,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                    }}
                  >
                    群
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: SPACE.xs, minWidth: 0, flex: 1 }}>
                    <span style={{ ...TYPE.body, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {group.title || group.conversation_id}
                    </span>
                    <span style={{ ...TYPE.meta, color: COLORS.subtle, ...TABULAR }}>
                      {group.member_count} 人 · {group.msg_count} 条消息 · {formatWhen(group.last_msg_at)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <section
        data-testid="group-detail"
        style={{ minHeight: 0, overflowY: "auto", height: "100%", padding: SPACE.xl, background: COLORS.surfaceAlt, borderLeft: `1px solid ${COLORS.border}` }}
      >
        {selected === null ? (
          <EmptyState icon="👥" text="从左侧选择一个群查看消息。" testId="group-detail-empty" />
        ) : (
          <>
            <h2 style={{ ...TYPE.panelTitle, margin: `0 0 ${SPACE.xs}px` }}>{selected.title || selected.conversation_id}</h2>
            <p style={{ ...TYPE.meta, color: COLORS.subtle, margin: `0 0 ${SPACE.lg}px`, ...TABULAR }}>
              {selected.member_count} 人 · {selected.msg_count} 条消息 · 最近 {formatWhen(selected.last_msg_at)}
            </p>
            {messages.length === 0 ? (
              <EmptyState icon="💬" text="这个群还没有可显示的消息。" testId="group-timeline-empty" />
            ) : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, borderLeft: `1px solid ${COLORS.border}`, marginLeft: SPACE.sm }}>
                {messages.map((message) => (
                  <li key={message.message_id} style={{ position: "relative", padding: `0 0 ${SPACE.md}px ${SPACE.lg}px` }}>
                    <span style={{ position: "absolute", left: -4, top: 5, width: 7, height: 7, borderRadius: RADIUS.pill, background: COLORS.borderStrong }} />
                    <div style={{ fontSize: 11, color: COLORS.subtle, ...TABULAR }}>
                      {`${message.msg_date} · ${message.sender_name || message.role}`}
                    </div>
                    {message.content !== "" && (
                      <div style={{ fontSize: 12, color: COLORS.muted }}>{message.content}</div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </div>
  );
}
