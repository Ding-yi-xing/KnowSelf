/**
 * 画像面板（M3，只读）——`main` keyed slot `knowself-profile` 的 occupant。
 *
 * 布局：左列分层目录（**L1 核心画像** + **L2 卡片**），右侧详情。
 *   - 选中 L1 → 显示 `CoreProfileStored`：display_name / locale / section_tags / body / updated_at；
 *   - 选中 L2 → 显示 `CardWithSections`：标题 / 摘要 / 标签 / updated_at + 各 section 正文。
 *
 * 数据只经 `KnowselfProfilePort`（props 注入），面板不 import `@knowself/profile-store`
 * 运行时（浏览器直连不了 better-sqlite3）。零 UI 库依赖：原生元素 + 内联样式。
 *
 * 三种态严格区分（05 §14 约束 4），文案与 testid 固定，便于测试与人工核对：
 *   降级 503 → 「数据层未就绪：<reason>」+ 重试（`profile-panel-degraded`）
 *   会话失效 401 → 「会话已失效，请重新打开 dsh web」（`profile-panel-session-expired`）
 *   其它错误 → 「数据读取失败：<message>」（`profile-panel-error`）
 *
 * **只读**：本面板没有任何写操作入口（D-B 决议：写操作仍由 agent 工具承担）。
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { CardSummary, CardWithSections, CoreProfileStored } from "@knowself/contracts";
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

/** 组件 props。 */
export interface ProfilePanelViewProps {
  /** 只读数据端口（由 client 入口装配，默认走同 origin REST）。 */
  port: KnowselfProfilePort;
}

/** 左列当前选中项：L1 核心，或某张 L2 卡片。 */
type Selection = { kind: "core" } | { kind: "card"; key: string };

/** 错误态种类（与「数据」互斥）。 */
type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };

/**
 * 画像面板主区视图。
 * 加载流程：`getProfileCore()` + `listCards()` 并发 → 选中 → 卡片详情按需 `getCard(key)`；
 * 卸载时以 `cancelled` 取消挂起更新（与 `person-panel.tsx` 同一模式）。
 */
export function ProfilePanelView({ port }: ProfilePanelViewProps): ReactElement {
  const [core, setCore] = useState<CoreProfileStored | null>(null);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cardDetail, setCardDetail] = useState<CardWithSections | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  /** 重试令牌：递增即重新拉取（保留重试按钮）。 */
  const [reloadToken, setReloadToken] = useState<number>(0);

  /** 把异常翻译成面板态（三种必须可区分）。 */
  const toFailure = useCallback((err: unknown): PanelFailure => {
    if (err instanceof SessionExpiredError) return { kind: "session" };
    if (err instanceof DegradedError) return { kind: "degraded", reason: err.reason };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }, []);

  // L1 核心 + L2 卡片列表
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailure(null);
      try {
        const [coreProfile, cardList] = await Promise.all([
          port.getProfileCore(),
          port.listCards(),
        ]);
        if (cancelled) return;
        setCore(coreProfile);
        setCards(cardList);
        // 默认选中 L1 核心：面板打开即有内容（避免「请从左侧选择」的空屏）。
        setSelection((prev) => prev ?? { kind: "core" });
      } catch (err) {
        if (!cancelled) {
          setFailure(toFailure(err));
          setCore(null);
          setCards([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken, toFailure]);

  // 选中卡片的详情（含 sections）
  useEffect(() => {
    if (selection === null || selection.kind !== "card") {
      setCardDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await port.getCard(selection.key);
        if (!cancelled) setCardDetail(detail);
      } catch (err) {
        if (!cancelled) {
          setCardDetail(null);
          setFailure(toFailure(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, selection, toFailure]);

  const coreSelected = selection !== null && selection.kind === "core";
  const selectedCardKey = selection !== null && selection.kind === "card" ? selection.key : null;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        fontFamily: "system-ui, sans-serif",
        color: PANEL_COLORS.text,
        background: PANEL_COLORS.surface,
      }}
    >
      {/* 左：分层目录（L1 核心 / L2 卡片） */}
      <aside
        style={{
          width: 260,
          minWidth: 200,
          flexShrink: 0,
          borderRight: `1px solid ${PANEL_COLORS.border}`,
          overflowY: "auto",
          padding: 12,
        }}
      >
        <h2 style={{ fontSize: 15, margin: "4px 0 12px" }}>画像</h2>

        {failure !== null && failure.kind === "degraded" && (
          <DegradedNotice
            reason={failure.reason}
            onRetry={() => setReloadToken((n) => n + 1)}
            testId="profile-panel-degraded"
          />
        )}
        {failure !== null && failure.kind === "session" && (
          <SessionExpiredNotice testId="profile-panel-session-expired" />
        )}
        {failure !== null && failure.kind === "error" && (
          <ErrorNotice message={failure.message} testId="profile-panel-error" />
        )}

        {loading && <LoadingNotice />}

        {/* L1 分组 */}
        <h3 style={GROUP_TITLE}>L1 · 核心画像</h3>
        {core === null ? (
          <EmptyNotice text={loading ? "读取中…" : "暂无核心画像。"} />
        ) : (
          <button
            type="button"
            aria-pressed={coreSelected}
            onClick={() => setSelection({ kind: "core" })}
            style={itemStyle(coreSelected)}
          >
            <div style={{ fontSize: 13, fontWeight: 600, ...WRAP_TEXT }}>
              {core.display_name === "" ? "（未命名）" : core.display_name}
            </div>
            <div style={{ fontSize: 11, color: PANEL_COLORS.muted }}>
              {core.locale} · {core.body.length} 字
            </div>
          </button>
        )}

        {/* L2 分组 */}
        <h3 style={GROUP_TITLE}>L2 · 卡片（{cards.length}）</h3>
        {cards.length === 0 ? (
          <EmptyNotice text={loading ? "读取中…" : "暂无卡片。"} />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {cards.map((card) => {
              const active = card.key === selectedCardKey;
              return (
                <li key={card.key} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelection({ kind: "card", key: card.key })}
                    style={itemStyle(active)}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, ...WRAP_TEXT }}>
                      {card.title === "" ? card.key : card.title}
                    </div>
                    <div style={{ fontSize: 11, color: PANEL_COLORS.muted, ...WRAP_TEXT }}>
                      {card.key}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* 右：详情 */}
      <section style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 16 }}>
        {selection === null ? (
          <EmptyNotice text="从左侧选择核心画像或一张卡片查看内容。" />
        ) : selection.kind === "core" ? (
          <CoreDetail core={core} />
        ) : (
          <CardDetail detail={cardDetail} cardKey={selection.key} />
        )}
      </section>
    </div>
  );
}

/** 分组标题样式（与正文区分层级）。 */
const GROUP_TITLE = {
  fontSize: 12,
  fontWeight: 600,
  color: PANEL_COLORS.muted,
  margin: "14px 0 6px",
  letterSpacing: "0.02em",
} as const;

/** 左列条目按钮样式（选中态高亮，与 person-panel 一致）。 */
function itemStyle(active: boolean): {
  width: string;
  textAlign: "left";
  cursor: "pointer";
  border: string;
  borderColor: string;
  background: string;
  borderRadius: number;
  padding: string;
  color: string;
} {
  return {
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
    border: "1px solid",
    borderColor: active ? PANEL_COLORS.accent : PANEL_COLORS.border,
    background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface,
    borderRadius: 6,
    padding: "6px 8px",
    color: PANEL_COLORS.text,
  };
}

/** L1 核心详情。 */
function CoreDetail({ core }: { core: CoreProfileStored | null }): ReactElement {
  if (core === null) return <EmptyNotice text="暂无核心画像数据。" />;
  return (
    <>
      <h2 style={{ fontSize: 17, margin: "0 0 12px", ...WRAP_TEXT }}>
        {core.display_name === "" ? "（未命名）" : core.display_name}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <InfoField label="显示名" value={core.display_name} />
        <InfoField label="语言" value={core.locale} />
        <InfoField label="分区标签" value={<TagChips tags={core.section_tags} />} />
        <InfoField label="更新时间" value={core.updated_at} />
      </div>
      <h3 style={SECTION_TITLE}>正文</h3>
      <div
        data-testid="profile-core-body"
        style={{
          fontSize: 13,
          lineHeight: 1.7,
          background: PANEL_COLORS.subtleBg,
          border: `1px solid ${PANEL_COLORS.border}`,
          borderRadius: 6,
          padding: 10,
          ...WRAP_TEXT,
        }}
      >
        {core.body === "" ? "—" : core.body}
      </div>
    </>
  );
}

/** L2 卡片详情（标题 + 摘要 + 标签 + sections）。 */
function CardDetail({
  detail,
  cardKey,
}: {
  detail: CardWithSections | null;
  cardKey: string;
}): ReactElement {
  if (detail === null) return <LoadingNotice text="读取卡片中…" />;
  return (
    <>
      <h2 style={{ fontSize: 17, margin: "0 0 12px", ...WRAP_TEXT }}>
        {detail.card.title === "" ? cardKey : detail.card.title}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <InfoField label="key" value={detail.card.key} />
        <InfoField label="摘要" value={detail.card.summary} />
        <InfoField label="分区标签" value={<TagChips tags={detail.card.section_tags} />} />
        <InfoField label="更新时间" value={detail.card.updated_at} />
      </div>
      <h3 style={SECTION_TITLE}>分节（{detail.sections.length}）</h3>
      {detail.sections.length === 0 ? (
        <EmptyNotice text="这张卡片还没有分节内容。" />
      ) : (
        detail.sections.map((section) => (
          <article key={section.id} style={{ marginBottom: 14 }}>
            <h4 style={{ fontSize: 13, margin: "0 0 4px", ...WRAP_TEXT }}>{section.title}</h4>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.7,
                background: PANEL_COLORS.subtleBg,
                border: `1px solid ${PANEL_COLORS.border}`,
                borderRadius: 6,
                padding: 10,
                ...WRAP_TEXT,
              }}
            >
              {section.body === "" ? "—" : section.body}
            </div>
          </article>
        ))
      )}
    </>
  );
}

/** 详情区小节标题样式。 */
const SECTION_TITLE = {
  fontSize: 14,
  margin: "20px 0 8px",
} as const;
