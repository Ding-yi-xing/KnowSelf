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
import { PanelHeading, PanelShell, Pill, useContainerWidth } from "./ui-kit.js";
import { ConfirmDialog } from "./modal.js";
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
 * 把 ISO 时间格式化成列表里易读的 `YYYY-MM-DD HH:mm`。
 * @param value ISO 时间
 * @returns 格式化时间；无法解析时回退原字符串
 */
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 列表只展示建议正文的短摘要，完整内容放到展开区。
 * @param value 建议正文
 * @param max 最大字符数
 * @returns 摘要
 */
function previewText(value: string, max = 100): string {
  const text = value.trim();
  if (text === "") return "（无正文）";
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
  /** 当前展开详细信息的提案 id（null = 全部收起）。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 多选采纳：已勾选的提案 id。 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /** 批量采纳进行中（与单条 busyId 分开，避免互相禁用错乱）。 */
  const [batchBusy, setBatchBusy] = useState<boolean>(false);
  /** 批量采纳失败/部分失败的提示。 */
  const [batchError, setBatchError] = useState<string | null>(null);
  /** 批量采纳确认弹窗。 */
  const [confirmBatch, setConfirmBatch] = useState<boolean>(false);
  /** 批量拒绝确认弹窗。 */
  const [confirmBatchReject, setConfirmBatchReject] = useState<boolean>(false);
  /** 来源 id → 资料名（用于把同一份 PDF 的多个字段合成一张卡）。 */
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  /** 来源卡整体采纳/拒绝的确认。 */
  const [groupConfirm, setGroupConfirm] = useState<{ ids: string[]; decision: "accept" | "reject" } | null>(null);
  /** 待确认的决策（null = 无弹窗）。 */
  const [confirmDecision, setConfirmDecision] = useState<{ id: string; decision: "accept" | "reject" } | null>(null);
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

  // 列表刷新后清掉已不存在的选择，避免批量采纳带上已处理的 id。
  useEffect(() => {
    setSelectedIds((current) => {
      const available = new Set(proposals.filter((p) => p.status === "pending").map((p) => p.id));
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [proposals]);

  // 拉来源名，供来源级卡片显示 PDF/资料名称；失败只回退为“资料”。
  useEffect(() => {
    let cancelled = false;
    void port
      .listSources({ limit: 200 })
      .then((list) => {
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const source of list) {
          names[source.id] =
            source.original_name !== ""
              ? source.original_name
              : source.url !== null
                ? source.url
                : source.id.slice(0, 8);
        }
        setSourceNames(names);
      })
      .catch(() => {
        // 来源名只是展示增强，失败不覆盖待整理主数据。
      });
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken]);

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
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(proposalId);
        return next;
      });
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

  /**
   * 切换一条提案的勾选状态。
   * @param proposalId 提案 id
   */
  const toggleSelected = (proposalId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  };

  /**
   * 批量处理一组提案；逐条落档/丢弃，失败的保留并汇总提示。
   * @param ids 提案 id
   * @param decision 采纳或拒绝
   */
  const decideMany = async (ids: string[], decision: "accept" | "reject"): Promise<void> => {
    if (batchBusy || ids.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    let done = 0;
    let failed = 0;
    for (const proposalId of ids) {
      try {
        if (decision === "accept") await port.acceptProposal(proposalId);
        else await port.rejectProposal(proposalId);
        done += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setSelectedIds(new Set());
    setReloadToken((n) => n + 1);
    if (failed > 0) {
      const verb = decision === "accept" ? "采纳" : "拒绝";
      setBatchError(
        done > 0
          ? `已${verb} ${done} 条，${failed} 条失败；失败的仍保留在列表中。`
          : `批量${verb}失败：${failed} 条均未成功。`,
      );
    }
  };

  const acceptSelected = (): Promise<void> => decideMany([...selectedIds], "accept");
  const rejectSelected = (): Promise<void> => decideMany([...selectedIds], "reject");

  const selectable = proposals.filter((proposal) => proposal.status === "pending");
  const allSelected = selectable.length > 0 && selectable.every((proposal) => selectedIds.has(proposal.id));

  // 同一份资料蒸馏出的多个字段（一份 PDF 常出 5 条 card_section）合成一张来源卡；
  // 聊天提案永远一会话一条，不参与来源合并。
  const sourceGroupMap = new Map<string, IngestionProposal[]>();
  for (const proposal of proposals) {
    if (proposal.target.kind === "chat_message") continue;
    const list = sourceGroupMap.get(proposal.source_id) ?? [];
    list.push(proposal);
    sourceGroupMap.set(proposal.source_id, list);
  }
  const sourceGroups = [...sourceGroupMap.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([sourceId, list]) => ({ sourceId, proposals: list }));
  const groupedIds = new Set(sourceGroups.flatMap((group) => group.proposals.map((p) => p.id)));

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
        background: PANEL_COLORS.subtleBg,
      }}
    >
      <div
        ref={rootRef}
        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      >
        <PanelHeading title="待整理" />

        {/* 中部可滚动列表 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: `${SPACE.xl}px`,
          }}
        >
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 4,
              background: PANEL_COLORS.subtleBg,
              paddingBottom: SPACE.sm,
            }}
          >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: SPACE.md,
              marginBottom: SPACE.lg,
              padding: SPACE.lg,
              border: `1px solid ${PANEL_COLORS.border}`,
              borderRadius: RADIUS.card,
              background: PANEL_COLORS.surface,
              boxShadow: "0 4px 16px rgba(23, 32, 51, 0.035)",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 650 }}>待处理建议（{proposals.length}）</div>
              <div style={{ fontSize: 11, color: PANEL_COLORS.muted, marginTop: 2 }}>
                勾选多条后可批量采纳
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: PANEL_COLORS.muted }}>
                <input
                  type="checkbox"
                  data-testid="inbox-select-all"
                  checked={allSelected}
                  disabled={selectable.length === 0 || batchBusy}
                  onChange={() =>
                    setSelectedIds(allSelected ? new Set() : new Set(selectable.map((p) => p.id)))
                  }
                />
                全选
              </label>
              <button
                type="button"
                data-testid="inbox-batch-accept"
                disabled={selectedIds.size === 0 || batchBusy}
                onClick={() => setConfirmBatch(true)}
                style={{
                  ...PRIMARY_BUTTON,
                  opacity: selectedIds.size === 0 || batchBusy ? 0.5 : 1,
                }}
              >
                {batchBusy ? "处理中…" : `批量采纳${selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}`}
              </button>
              <button
                type="button"
                data-testid="inbox-batch-reject"
                disabled={selectedIds.size === 0 || batchBusy}
                onClick={() => setConfirmBatchReject(true)}
                style={{
                  ...SECONDARY_BUTTON,
                  opacity: selectedIds.size === 0 || batchBusy ? 0.5 : 1,
                }}
              >
                {batchBusy ? "处理中…" : `批量拒绝${selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}`}
              </button>
            </div>
          </div>
          </div>
          {batchError !== null && (
            <p
              role="alert"
              data-testid="inbox-batch-error"
              style={{ fontSize: 12, color: PANEL_COLORS.dangerText, marginBottom: SPACE.md, ...WRAP_TEXT }}
            >
              {batchError}
            </p>
          )}
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

          <div
            data-testid="inbox-grid"
            style={{
              display: "grid",
              gridTemplateColumns: isNarrow ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(250px, 1fr))",
              gap: SPACE.md,
              alignItems: "stretch",
            }}
          >
          {sourceGroups.map((group) => {
            const groupKey = `group:${group.sourceId}`;
            const groupSelected = group.proposals.every((p) => selectedIds.has(p.id));
            const sourceName = sourceNames[group.sourceId] ?? "资料";
            return (
              <article
                key={groupKey}
                data-testid="inbox-source-group"
                style={{
                  border: `1px solid ${PANEL_COLORS.border}`,
                  borderRadius: RADIUS.card,
                  padding: SPACE.md,
                  background: PANEL_COLORS.surface,
                  boxShadow: "0 4px 16px rgba(23, 32, 51, 0.04)",
                  display: "flex",
                  flexDirection: "column",
                  height: 260,
                  minHeight: 260,
                  overflow: "hidden",
                  boxSizing: "border-box",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: SPACE.sm, flexWrap: "wrap" }}>
                  <input
                    type="checkbox"
                    data-testid={`inbox-source-select-${group.sourceId}`}
                    aria-label="选择这份资料的全部建议"
                    checked={groupSelected}
                    disabled={batchBusy}
                    onChange={() =>
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (groupSelected) {
                          for (const p of group.proposals) next.delete(p.id);
                        } else {
                          for (const p of group.proposals) next.add(p.id);
                        }
                        return next;
                      })
                    }
                  />
                  <TagChips tags={[`${group.proposals.length} 项建议`, "同一份资料"]} />
                  <span style={{ marginLeft: "auto", fontSize: 11, color: PANEL_COLORS.muted }}>
                    {formatTime(group.proposals[0]!.created_at)}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 650, ...WRAP_TEXT }}>{sourceName}</div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: SPACE.sm, paddingRight: 2 }}>
                  {group.proposals.slice(0, expandedId === groupKey ? undefined : 3).map((p) => (
                    <div key={p.id} style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 4, ...WRAP_TEXT }}>
                      <span style={{ color: PANEL_COLORS.muted }}>{targetLabel(p.target)}：</span>
                      {previewText(p.proposed_body, expandedId === groupKey ? 400 : 40)}
                    </div>
                  ))}
                  {expandedId !== groupKey && group.proposals.length > 3 && (
                    <div style={{ fontSize: 12, color: PANEL_COLORS.muted }}>还有 {group.proposals.length - 3} 项…</div>
                  )}
                  {expandedId === groupKey &&
                    group.proposals.map((p) => (
                      <div key={`${p.id}-reason`} style={{ fontSize: 12, color: PANEL_COLORS.muted, marginTop: 4, ...WRAP_TEXT }}>
                        系统说明：{p.reasoning === "" ? "—" : p.reasoning}
                      </div>
                    ))}
                </div>
                <div style={{ display: "flex", gap: SPACE.sm, marginTop: SPACE.sm, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    data-testid={`inbox-source-expand-${group.sourceId}`}
                    aria-expanded={expandedId === groupKey}
                    onClick={() => setExpandedId(expandedId === groupKey ? null : groupKey)}
                    style={{ ...SECONDARY_BUTTON, padding: "5px 10px", fontSize: 12 }}
                  >
                    {expandedId === groupKey ? "收起" : "展开全部"}
                  </button>
                  <button
                    type="button"
                    data-testid={`inbox-source-accept-${group.sourceId}`}
                    disabled={batchBusy}
                    onClick={() => setGroupConfirm({ ids: group.proposals.map((p) => p.id), decision: "accept" })}
                    style={{ ...PRIMARY_BUTTON, padding: "5px 10px", fontSize: 12 }}
                  >
                    采纳全部
                  </button>
                  <button
                    type="button"
                    data-testid={`inbox-source-reject-${group.sourceId}`}
                    disabled={batchBusy}
                    onClick={() => setGroupConfirm({ ids: group.proposals.map((p) => p.id), decision: "reject" })}
                    style={{ ...SECONDARY_BUTTON, padding: "5px 10px", fontSize: 12 }}
                  >
                    拒绝全部
                  </button>
                </div>
              </article>
            );
          })}
          {proposals.map((proposal) => {
            if (groupedIds.has(proposal.id)) return null;
            const busy = busyId === proposal.id;
            const canDecide = proposal.status === "pending";
            const decideButtons = canDecide ? (
              <>
                <button
                  type="button"
                  data-testid={`inbox-accept-${proposal.id}`}
                  disabled={busyId !== null || batchBusy}
                  onClick={() => setConfirmDecision({ id: proposal.id, decision: "accept" })}
                  style={{ ...PRIMARY_BUTTON, padding: "5px 10px", fontSize: 12 }}
                >
                  {busy ? "处理中…" : "采纳"}
                </button>
                <button
                  type="button"
                  data-testid={`inbox-reject-${proposal.id}`}
                  disabled={busyId !== null || batchBusy}
                  onClick={() => setConfirmDecision({ id: proposal.id, decision: "reject" })}
                  style={{ ...SECONDARY_BUTTON, padding: "5px 10px", fontSize: 12 }}
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
                  background: PANEL_COLORS.surface,
                  boxShadow: "0 4px 16px rgba(23, 32, 51, 0.04)",
                  display: "flex",
                  flexDirection: "column",
                  height: 260,
                  minHeight: 260,
                  maxHeight: 260,
                  overflow: "hidden",
                  minWidth: 0,
                  boxSizing: "border-box",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: SPACE.sm, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", cursor: canDecide && !batchBusy ? "pointer" : "default" }} title="勾选后可批量采纳">
                    <input
                      type="checkbox"
                      data-testid={`inbox-select-${proposal.id}`}
                      aria-label="选择这条建议"
                      checked={selectedIds.has(proposal.id)}
                      disabled={!canDecide || batchBusy}
                      onChange={() => toggleSelected(proposal.id)}
                    />
                  </label>
                  <TagChips
                    tags={[TARGET_KIND_LABELS[proposal.target.kind], STATUS_LABELS[proposal.status]]}
                  />
                  <Pill kind="pending">{suggestedTargetLabel(proposal.target)}</Pill>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: PANEL_COLORS.muted, whiteSpace: "nowrap" }}>
                    {formatTime(proposal.created_at)}
                  </span>
                </div>

                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
                <div style={{ fontSize: 13, lineHeight: 1.55, fontWeight: 500, ...WRAP_TEXT }}>
                  {previewText(proposal.proposed_body)}
                </div>

                <button
                  type="button"
                  data-testid={`inbox-expand-${proposal.id}`}
                  aria-expanded={expandedId === proposal.id}
                  onClick={() => setExpandedId(expandedId === proposal.id ? null : proposal.id)}
                  style={{ ...SECONDARY_BUTTON, marginTop: SPACE.sm, padding: "5px 10px", fontSize: 12, alignSelf: "flex-start" }}
                >
                  {expandedId === proposal.id ? "收起详情" : "展开详情"}
                </button>

                {expandedId === proposal.id && (
                  <div
                    data-testid={`inbox-details-${proposal.id}`}
                    style={{
                      marginTop: SPACE.md,
                      paddingTop: SPACE.md,
                      borderTop: `1px solid ${PANEL_COLORS.border}`,
                    }}
                  >
                    <InfoField label="归档目标" value={targetLabel(proposal.target)} />
                    <InfoField label="来源" value={proposal.source_id} />
                    <InfoField label="创建时间" value={proposal.created_at} />
                    {proposal.decided_at === null ? null : (
                      <InfoField label="决策时间" value={proposal.decided_at} />
                    )}
                    {proposal.reasoning === "" ? null : (
                      <InfoField label="系统说明" value={proposal.reasoning} />
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
                  </div>
                )}

                </div>

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
                {canDecide && <div style={{ marginTop: SPACE.sm }}>
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
      </div>

      <ConfirmDialog
        open={confirmDecision !== null}
        title={confirmDecision?.decision === "reject" ? "拒绝提案" : "采纳提案"}
        danger={confirmDecision?.decision === "reject"}
        busy={busyId !== null}
        message={
          confirmDecision === null
            ? ""
            : confirmDecision.decision === "accept"
              ? "采纳后会按这条建议写入画像/档案。确认采纳？"
              : "拒绝后该提案会被丢弃，不再出现在待整理列表。确认拒绝？"
        }
        confirmLabel={confirmDecision?.decision === "reject" ? "确认拒绝" : "确认采纳"}
        onCancel={() => setConfirmDecision(null)}
        onConfirm={() => {
          const pending = confirmDecision;
          if (pending === null) return;
          setConfirmDecision(null);
          void decide(pending.id, pending.decision);
        }}
        testId="inbox-decision-dialog"
        confirmTestId="inbox-decision-confirm"
      />

      <ConfirmDialog
        open={confirmBatch}
        title="批量采纳提案"
        busy={batchBusy}
        message={`确认采纳选中的 ${selectedIds.size} 条建议？采纳后会按各自目标写入画像/档案。`}
        confirmLabel={`确认采纳（${selectedIds.size}）`}
        onCancel={() => setConfirmBatch(false)}
        onConfirm={() => {
          setConfirmBatch(false);
          void acceptSelected();
        }}
        testId="inbox-batch-dialog"
        confirmTestId="inbox-batch-confirm"
      />

      <ConfirmDialog
        open={confirmBatchReject}
        title="批量拒绝提案"
        danger
        busy={batchBusy}
        message={`确认拒绝选中的 ${selectedIds.size} 条建议？拒绝后会被丢弃，不再出现在待整理列表。`}
        confirmLabel={`确认拒绝（${selectedIds.size}）`}
        onCancel={() => setConfirmBatchReject(false)}
        onConfirm={() => {
          setConfirmBatchReject(false);
          void rejectSelected();
        }}
        testId="inbox-batch-reject-dialog"
        confirmTestId="inbox-batch-reject-confirm"
      />

      <ConfirmDialog
        open={groupConfirm !== null}
        title={groupConfirm?.decision === "reject" ? "拒绝整份资料的建议" : "采纳整份资料的建议"}
        danger={groupConfirm?.decision === "reject"}
        busy={batchBusy}
        message={
          groupConfirm === null
            ? ""
            : groupConfirm.decision === "accept"
              ? `将一次采纳这份资料的 ${groupConfirm.ids.length} 项字段建议，确认继续？`
              : `将拒绝这份资料的 ${groupConfirm.ids.length} 项字段建议，确认继续？`
        }
        confirmLabel={groupConfirm?.decision === "reject" ? "确认拒绝全部" : "确认采纳全部"}
        onCancel={() => setGroupConfirm(null)}
        onConfirm={() => {
          const pending = groupConfirm;
          if (pending === null) return;
          setGroupConfirm(null);
          void decideMany(pending.ids, pending.decision);
        }}
        testId="inbox-source-confirm-dialog"
        confirmTestId="inbox-source-confirm"
      />
    </PanelShell>
  );
}
