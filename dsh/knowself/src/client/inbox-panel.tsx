/**
 * 待整理面板（inbox，M3 波 2；本轮 UI 重设计改为**可决策**）——`main` keyed slot
 * `knowself-inbox` 的 occupant。
 *
 * 「待整理」= `profileStore.proposals` 里 `status="pending"` 的摄入提案：蒸馏层读完一份
 * 资料后给出的「写入档案的建议」。本轮起，面板**不再只读**：每条直接给「采纳（主）/
 * 拒绝（次）」按钮，落档/丢弃逻辑走服务端 `@knowself/ingestion.acceptProposal /
 * rejectProposal`（经 `KnowselfProfilePort.acceptProposal / rejectProposal` 接线，不重写）。
 *
 * ## 系统建议文案的来源（关键）
 * 建议归档目标是**分类器**写进 `proposal.target_ref` 的 `suggested_target`
 * （`person` / `material` / `discard` / `chat_only`，见 `archive-classifier.ts` 的
 * `ArchiveTarget`）。领域库 `listProposals` 把 `target_ref` 原样解析成 `target` 对象返回，
 * 所以面板从 `target.suggested_target` 读。契约层（contracts）**没有**声明这个字段——
 * 它是运行时附加在 `target` 上的判定结果（`profile-store/repository/proposals.ts`
 * `target["suggested_target"] = verdict.target`），因此这里用窄化类型读，缺省回退「待确认」。
 *
 * 展示字段来自领域库真实返回（`IngestionProposal`）：类别 / 目标 / 摘要 / 理由 / 来源 / 时间。
 *
 * 数据只经 `KnowselfProfilePort`（props 注入），面板不 import 领域库运行时。
 * 零 UI 库依赖：原生元素 + 内联样式，通用态复用 `panel-states.tsx`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IngestionProposal, ProposalStatus, ProposalTarget } from "@knowself/contracts";
import {
  DegradedError,
  SessionExpiredError,
  type KnowselfProfilePort,
} from "./profile-port.js";
import { PanelShell, Pill, useContainerWidth } from "./ui-kit.js";
import {
  COLORS,
  NARROW_BREAKPOINT,
  PRIMARY_BUTTON,
  RADIUS,
  SECONDARY_BUTTON,
  SPACE,
  TYPE,
} from "./ui-tokens.js";
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
export interface InboxPanelViewProps {
  /** 数据端口（由 client 入口装配，默认走同 origin REST）。 */
  port: KnowselfProfilePort;
}

/** 错误态种类（与「数据」互斥）。 */
type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };

/** 提案类别 → 中文。 */
const TARGET_KIND_LABELS: Readonly<Record<ProposalTarget["kind"], string>> = {
  core: "核心画像",
  card_section: "卡片分节",
  journal: "日志",
  chat_message: "聊天消息",
  source_distill: "会话蒸馏审核",
};

/** 提案状态 → 中文。 */
const STATUS_LABELS: Readonly<Record<ProposalStatus, string>> = {
  pending: "待整理",
  processing: "蒸馏中",
  accepted: "已接受",
  edited: "已编辑",
  rejected: "已忽略",
};

/**
 * 分类器给出的「建议归档目标」→ 一句人话。
 *
 * 值域与 `archive-classifier.ts` 的 `ArchiveTarget` 完全一致（**新增值在这里补**，别散落别处）：
 *   - person     → 建议建一个人物档案
 *   - material   → 建议当资料 / 记忆归档
 *   - discard    → 建议丢弃（系统消息 / 纯表情 / 服务号这类噪音）
 *   - chat_only  → 只进图谱看关系，不建个人档案（群聊人多）
 *
 * @param target 提案落档目标（可能携带运行时附加的 `suggested_target`）
 * @returns 一句话建议
 */
function suggestedTargetLabel(target: ProposalTarget): string {
  const suggested = (target as ProposalTarget & { suggested_target?: string }).suggested_target;
  switch (suggested) {
    case "person":
      return "建议归入人物档案";
    case "material":
      return "建议归入资料库";
    case "discard":
      return "建议丢弃（系统消息 / 纯表情 / 服务号，不建档）";
    case "chat_only":
      return "建议仅进图谱（群聊，不建个人档案）";
    default:
      return "待确认归档目标";
  }
}

/**
 * 把 `target` 联合类型展开成一行人读的目标描述（不在数据里造字段，只做文案映射）。
 * @param target 提案落档目标
 * @returns 形如「画像卡片 skills · 职业」/「2026-05-30」/「会话 conv-1（review，3 条消息）」
 */
function targetLabel(target: ProposalTarget): string {
  switch (target.kind) {
    case "core":
      return "L1 核心画像（整页覆盖）";
    case "card_section":
      return `画像卡片 ${target.card_key} · ${target.section}`;
    case "journal":
      return `日志 ${target.date}`;
    case "chat_message":
      return `会话 ${target.conversation_id}（${target.tier}，${target.message_ids.length} 条消息）`;
    case "source_distill":
      return `会话蒸馏审核（置信度 ${Math.round(target.confidence * 100)}%）`;
    default:
      return "未知目标";
  }
}

/**
 * 待整理面板主区视图。
 * 加载流程：`listProposals("pending")` → 渲染列表；卸载时以 `cancelled` 取消挂起更新。
 * 采纳 / 拒绝成功后递增 `reloadToken`，让该条离开待整理列表。
 */
export function InboxPanelView({ port }: InboxPanelViewProps): ReactElement {
  const [proposals, setProposals] = useState<IngestionProposal[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  /** 重试令牌：递增即重新拉取（降级态重试 / 决策成功后刷新）。 */
  const [reloadToken, setReloadToken] = useState<number>(0);
  /** 正在决策的提案 id（null = 空闲）；同一时刻只允许一条，避免双击重复提交。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 决策失败的局部提示（不覆盖整页 failure）。 */
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  /** 窄屏下展开「⋯」菜单的提案 id（null = 收起）。 */
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  /** 响应式：容器宽度（jsdom 下 Infinity = 宽屏）。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerWidth = useContainerWidth(rootRef);
  const isNarrow = containerWidth < NARROW_BREAKPOINT;

  /** 把异常翻译成面板态（三种必须可区分）。 */
  const toFailure = useCallback((err: unknown): PanelFailure => {
    if (err instanceof SessionExpiredError) return { kind: "session" };
    if (err instanceof DegradedError) return { kind: "degraded", reason: err.reason };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailure(null);
      try {
        const list = await port.listProposals("pending");
        if (cancelled) return;
        setProposals(list);
      } catch (err) {
        if (!cancelled) {
          setFailure(toFailure(err));
          setProposals([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken, toFailure]);

  /**
   * 采纳 / 拒绝一条提案。成功后刷新列表（该条离开 pending）；失败显示局部原因，不静默。
   * @param proposalId 提案 id
   * @param decision 决策
   */
  const decide = async (proposalId: string, decision: "accept" | "reject"): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(proposalId);
    setActionError(null);
    try {
      if (decision === "accept") await port.acceptProposal(proposalId);
      else await port.rejectProposal(proposalId);
      setMenuOpenId(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setActionError({
        id: proposalId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PanelShell
      testId="inbox-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontFamily: "system-ui, sans-serif",
        color: PANEL_COLORS.text,
        background: PANEL_COLORS.surface,
      }}
    >
      <div
        ref={rootRef}
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      >
        {/* 顶部标题 + 计数 */}
        <header style={{ padding: "12px 16px 8px", flexShrink: 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, margin: "0 0 4px" }}>待整理</h2>
          <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: 0 }}>
            共 {proposals.length} 条待审提案
          </p>
        </header>

        {/* 中部可滚动列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 16px 16px" }}>
          {failure !== null && failure.kind === "degraded" && (
            <DegradedNotice
              reason={failure.reason}
              onRetry={() => setReloadToken((n) => n + 1)}
              testId="inbox-panel-degraded"
            />
          )}
          {failure !== null && failure.kind === "session" && (
            <SessionExpiredNotice testId="inbox-panel-session-expired" />
          )}
          {failure !== null && failure.kind === "error" && (
            <ErrorNotice message={failure.message} testId="inbox-panel-error" />
          )}

          {loading && <LoadingNotice />}
          {!loading && failure === null && proposals.length === 0 && (
            <EmptyNotice
              icon="🗳"
              text="没有待整理的提案。"
              action={
                <button
                  type="button"
                  onClick={() => setReloadToken((n) => n + 1)}
                  style={{
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                    padding: "8px 12px",
                    border: `1px solid ${PANEL_COLORS.accent}`,
                    background: PANEL_COLORS.accent,
                    color: "#ffffff",
                    borderRadius: 6,
                    fontFamily: "inherit",
                  }}
                >
                  刷新
                </button>
              }
            />
          )}

          {proposals.map((proposal) => {
            const busy = busyId === proposal.id;
            const canDecide = proposal.status === "pending";
            const decideButtons = canDecide ? (
              <>
                <button
                  type="button"
                  data-testid={`inbox-accept-${proposal.id}`}
                  disabled={busyId !== null}
                  onClick={() => void decide(proposal.id, "accept")}
                  style={PRIMARY_BUTTON}
                >
                  {busy ? "处理中…" : "采纳"}
                </button>
                <button
                  type="button"
                  data-testid={`inbox-reject-${proposal.id}`}
                  disabled={busyId !== null}
                  onClick={() => void decide(proposal.id, "reject")}
                  style={SECONDARY_BUTTON}
                >
                  拒绝
                </button>
              </>
            ) : null;
            return (
              <article
                key={proposal.id}
                data-testid="inbox-panel-item"
                style={{
                  border: `1px solid ${PANEL_COLORS.border}`,
                  borderRadius: RADIUS.card,
                  padding: SPACE.md,
                  marginBottom: SPACE.md,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: SPACE.sm, flexWrap: "wrap" }}>
                  <TagChips
                    tags={[TARGET_KIND_LABELS[proposal.target.kind], STATUS_LABELS[proposal.status]]}
                  />
                  <Pill kind="pending">{suggestedTargetLabel(proposal.target)}</Pill>
                </div>
                <InfoField label="类别" value={TARGET_KIND_LABELS[proposal.target.kind]} />
                <InfoField label="目标" value={targetLabel(proposal.target)} />
                <InfoField label="来源" value={proposal.source_id} />
                <InfoField label="时间" value={proposal.created_at} />
                {proposal.decided_at === null ? null : (
                  <InfoField label="决策时间" value={proposal.decided_at} />
                )}
                {proposal.reasoning === "" ? null : (
                  <InfoField label="理由" value={proposal.reasoning} />
                )}
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.7,
                    background: PANEL_COLORS.subtleBg,
                    border: `1px solid ${PANEL_COLORS.border}`,
                    borderRadius: RADIUS.control,
                    padding: SPACE.sm,
                    marginTop: SPACE.sm,
                    ...WRAP_TEXT,
                  }}
                >
                  {proposal.proposed_body === "" ? "—" : proposal.proposed_body}
                </div>
                {proposal.user_edited_body === null ? null : (
                  <div style={{ marginTop: 6, fontSize: 12, color: PANEL_COLORS.muted, ...WRAP_TEXT }}>
                    已编辑正文：{proposal.user_edited_body === "" ? "—" : proposal.user_edited_body}
                  </div>
                )}

                {actionError !== null && actionError.id === proposal.id && (
                  <p
                    role="alert"
                    data-testid="inbox-action-error"
                    style={{ fontSize: 12, color: PANEL_COLORS.dangerText, marginTop: SPACE.sm, ...WRAP_TEXT }}
                  >
                    操作失败：{actionError.message}
                  </p>
                )}

                {/* 宽屏：行内按钮；窄屏：收进 ⋯ 菜单（同一组按钮，两种呈现） */}
                {canDecide && <div style={{ marginTop: SPACE.md }}>
                  {isNarrow ? (
                    <div style={{ position: "relative" }}>
                      <button
                        type="button"
                        aria-label="更多操作"
                        aria-expanded={menuOpenId === proposal.id}
                        onClick={() => setMenuOpenId(menuOpenId === proposal.id ? null : proposal.id)}
                        style={SECONDARY_BUTTON}
                      >
                        ⋯
                      </button>
                      {menuOpenId === proposal.id && (
                        <div
                          style={{
                            position: "absolute",
                            top: "100%",
                            left: 0,
                            marginTop: SPACE.xs,
                            display: "flex",
                            flexDirection: "column",
                            gap: SPACE.xs,
                            padding: SPACE.xs,
                            border: `1px solid ${PANEL_COLORS.border}`,
                            borderRadius: RADIUS.control,
                            background: PANEL_COLORS.surface,
                            boxShadow: "0 8px 24px rgba(0,0,0,.12)",
                            zIndex: 5,
                          }}
                        >
                          {decideButtons}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: SPACE.sm }}>{decideButtons}</div>
                  )}
                </div>}
              </article>
            );
          })}
        </div>
      </div>
    </PanelShell>
  );
}
