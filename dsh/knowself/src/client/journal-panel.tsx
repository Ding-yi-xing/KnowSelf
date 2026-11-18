/**
 * 日志面板（M3，只读）——`main` keyed slot `knowself-journal` 的 occupant。
 *
 * 布局：左列有日志的日期（宿主已按日期倒序），右侧选中日期的记录列表。
 * 每条记录展示：ordinal / recorded_at / provenance / tags / body。
 *
 * 数据只经 `KnowselfProfilePort`（与画像面板同一端口，同为 L3/核心层数据源），
 * 面板不 import 领域库运行时。零 UI 库依赖：原生元素 + 内联样式。
 *
 * 三种态严格区分（05 §14 约束 4）：
 *   降级 503 → 「数据层未就绪：<reason>」+ 重试（`journal-panel-degraded`）
 *   会话失效 401 → 「会话已失效，请重新打开 dsh web」（`journal-panel-session-expired`）
 *   其它错误 → 「数据读取失败：<message>」（`journal-panel-error`）
 *
 * **只读**：没有「追加日志」入口（写操作由 agent 工具承担）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { JournalDateSummary, JournalEntryStored } from "@knowself/contracts";
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
import { NARROW_BREAKPOINT, RADIUS, SPACE, TYPE } from "./ui-tokens.js";

/** 组件 props。 */
export interface JournalPanelViewProps {
  /** 只读数据端口（由 client 入口装配，默认走同 origin REST）。 */
  port: KnowselfProfilePort;
}

/** 错误态种类（与「数据」互斥）。 */
type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };

/**
 * 日志面板主区视图。
 * 加载流程：`listJournalDates()` → 选中日期 → `getJournal(date)`；
 * 默认选中最新一天，打开面板即有内容。
 */
export function JournalPanelView({ port }: JournalPanelViewProps): ReactElement {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const narrow = useContainerWidth(layoutRef) < NARROW_BREAKPOINT;
  const [dates, setDates] = useState<JournalDateSummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [entry, setEntry] = useState<JournalEntryStored | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  /** 重试令牌：递增即重新拉取日期列表。 */
  const [reloadToken, setReloadToken] = useState<number>(0);

  /** 把异常翻译成面板态（三种必须可区分）。 */
  const toFailure = useCallback((err: unknown): PanelFailure => {
    if (err instanceof SessionExpiredError) return { kind: "session" };
    if (err instanceof DegradedError) return { kind: "degraded", reason: err.reason };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }, []);

  // 日期列表
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailure(null);
      try {
        const list = await port.listJournalDates();
        if (cancelled) return;
        setDates(list);
        // 默认选中最新一天（list[0] 即倒序第一项）。
        const newest = list[0];
        setSelectedDate((prev) => prev ?? (newest === undefined ? null : newest.date));
      } catch (err) {
        if (!cancelled) {
          setFailure(toFailure(err));
          setDates([]);
          setSelectedDate(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken, toFailure]);

  // 选中日期的记录
  useEffect(() => {
    if (selectedDate === null) {
      setEntry(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setDetailLoading(true);
      try {
        const journal = await port.getJournal(selectedDate);
        if (!cancelled) setEntry(journal);
      } catch (err) {
        if (!cancelled) {
          setEntry(null);
          setFailure(toFailure(err));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, selectedDate, toFailure]);

  return (
    <PanelShell
      testId="journal-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "system-ui, sans-serif",
        color: PANEL_COLORS.text,
        background: PANEL_COLORS.subtleBg,
      }}
    >
      <PanelHeading title="日志" />
      <div
        ref={layoutRef}
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          flexDirection: narrow ? "column" : "row",
          margin: SPACE.xl,
          overflow: "hidden",
          border: `1px solid ${PANEL_COLORS.border}`,
          borderRadius: RADIUS.card,
          background: PANEL_COLORS.surface,
          boxShadow: "0 8px 28px rgba(23, 32, 51, 0.05)",
        }}
      >
        <aside
          aria-label="日志日期"
          style={{
            width: narrow ? "auto" : 220,
            minWidth: narrow ? 0 : 180,
            maxHeight: narrow ? 220 : "none",
            flexShrink: 0,
            borderRight: narrow ? "none" : `1px solid ${PANEL_COLORS.border}`,
            borderBottom: narrow ? `1px solid ${PANEL_COLORS.border}` : "none",
            overflowY: "auto",
            padding: SPACE.lg,
            background: PANEL_COLORS.surface,
          }}
        >
        <div style={{ padding: `${SPACE.xs}px ${SPACE.sm}px ${SPACE.md}px`, marginBottom: SPACE.sm, borderBottom: `1px solid ${PANEL_COLORS.border}` }}>
          <h3 style={{ ...TYPE.section, margin: 0 }}>日期目录</h3>
        </div>

          {failure !== null && failure.kind === "degraded" && (
            <DegradedNotice
              reason={failure.reason}
              onRetry={() => setReloadToken((n) => n + 1)}
              testId="journal-panel-degraded"
            />
          )}
          {failure !== null && failure.kind === "session" && (
            <SessionExpiredNotice testId="journal-panel-session-expired" />
          )}
          {failure !== null && failure.kind === "error" && (
            <ErrorNotice message={failure.message} testId="journal-panel-error" />
          )}

          {loading && <LoadingNotice />}
          {!loading && dates.length === 0 && <EmptyNotice text="暂无日志日期。" />}

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {dates.map((row) => {
              const active = row.date === selectedDate;
              return (
                <li key={row.date} style={{ marginBottom: SPACE.xs }}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedDate(row.date)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      cursor: "pointer",
                      border: "1px solid",
                      borderColor: active ? PANEL_COLORS.accent : PANEL_COLORS.border,
                      background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface,
                      borderRadius: RADIUS.control,
                      padding: `${SPACE.sm}px`,
                      color: PANEL_COLORS.text,
                    }}
                  >
                    <div style={{ ...TYPE.section }}>{row.date}</div>
                    <div style={{ ...TYPE.meta, color: PANEL_COLORS.muted }}>
                      {row.record_count} 条记录
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section
          aria-label="日志记录"
          style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: SPACE.xl, background: PANEL_COLORS.subtleBg }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: SPACE.md, marginBottom: SPACE.lg }}>
            <div style={{ fontSize: 13, fontWeight: 650 }}>当日记录</div>
            {selectedDate !== null && <span style={{ fontSize: 11, color: PANEL_COLORS.muted }}>{selectedDate}</span>}
          </div>
          {selectedDate === null ? (
            <EmptyNotice text="从左侧选择一个日期查看日志。" />
          ) : (
            <>
              <h2 style={{ ...TYPE.panelTitle, margin: `0 0 ${SPACE.xs}px` }}>{selectedDate}</h2>
              <p style={{ ...TYPE.meta, color: PANEL_COLORS.muted, margin: `0 0 ${SPACE.md}px` }}>
                共 {entry === null ? 0 : entry.records.length} 条记录
              </p>
              {detailLoading && <LoadingNotice text="读取记录中…" />}
              {!detailLoading && entry !== null && entry.records.length === 0 && (
                <EmptyNotice text="这一天没有日志记录。" />
              )}
              {entry !== null &&
                entry.records.map((record) => (
                  <article
                    key={record.id}
                    style={{
                      border: `1px solid ${PANEL_COLORS.border}`,
                      borderRadius: RADIUS.card,
                      padding: SPACE.lg,
                      marginBottom: SPACE.md,
                      background: PANEL_COLORS.surface,
                      boxShadow: "0 3px 12px rgba(23, 32, 51, 0.035)",
                    }}
                  >
                    <div style={{ ...TYPE.meta, color: PANEL_COLORS.muted, marginBottom: SPACE.sm }}>
                      #{record.ordinal} · {record.recorded_at} · {record.provenance}
                    </div>
                    <div
                      style={{
                        ...TYPE.body,
                        background: PANEL_COLORS.subtleBg,
                        borderRadius: RADIUS.control,
                        padding: SPACE.sm,
                        ...WRAP_TEXT,
                      }}
                    >
                      {record.body === "" ? "—" : record.body}
                    </div>
                    {record.tags.length > 0 && (
                      <div style={{ marginTop: SPACE.sm }}>
                        <InfoField label="标签" value={<TagChips tags={record.tags} />} />
                      </div>
                    )}
                  </article>
                ))}
            </>
          )}
        </section>
      </div>
    </PanelShell>
  );
}
