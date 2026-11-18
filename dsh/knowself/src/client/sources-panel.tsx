/**
 * 资料面板（sources，M3 波 2；W-1 起支持摄入与重新蒸馏）——`main` keyed slot `knowself-sources` 的 occupant。
 *
 * 「资料」= 用户提供的原始素材（TXT / MD / JSON / 网址 / 粘贴文本），落库在 `profileStore.sources`。
 * 面板既展示列表，也提供两个写入口：header 的「添加资料」三 tab 表单（`SourcesAddForm`），
 * 以及每行资料的「重新蒸馏」按钮。写请求经 `KnowselfProfilePort` 的两个写方法打到宿主
 * handler 型路由（物理前缀 `/write`）；前缀映射封装在端口内部，面板不感知。
 *
 * 展示字段全部来自领域库真实返回（`SourceStored`，见 packages/contracts/src/source.ts:136）：
 *   名称   original_name（`url` 类为空时退回 url，`paste` 类为空时退回 id 前 8 位）
 *   类型   kind（file / url / paste）+ mime_type
 *   状态   status（raw / distilling / pending_review / completed / rejected / distill_failed）
 *   待整理提案
 *          该资料当前仍是 `pending` 的提案数（由 `listProposals("pending")` 按 `source_id`
 *          聚合得到；`SourceStored` 本身**没有**条目数字段，故不臆造，改用真实提案计数。
 *          表头是「待整理提案」而不是「条目数」——数值文案为 `N 条待整理`，
 *          旧表头与数值语义不一致（M3 波 3 文案修正）。
 *          待整理列表读不到时显示「—」，绝不用 0 冒充「没有条目」）
 *   更新时间 last_ingested_at（最近一次蒸馏时间），为空时退回 created_at
 *   其它   字符数 char_count / 标签 user_tags / 蒸馏失败 last_error（有才显示）
 *
 * 数据只经 `KnowselfProfilePort`（props 注入），面板不 import 领域库运行时。
 * 零 UI 库依赖：原生元素 + 内联样式，三种态复用 `panel-states.tsx`（05 §14 约束 4）。
 * 表单逻辑拆到 `sources-add-form.tsx`，本文件只做展开 / 收起与列表刷新编排。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IngestionProposal, SourceStatus, SourceStored } from "@knowself/contracts";
import type { KnowselfProfilePort } from "./profile-port.js";
import { DegradedError, SessionExpiredError } from "./profile-port.js";
import { SourcesAddForm } from "./sources-add-form.js";
import { WechatAssistSection } from "./wechat-assist-section.js";
import { ConfirmDialog, Modal } from "./modal.js";
import { Avatar, PanelHeading, PanelShell, Pill, useContainerWidth } from "./ui-kit.js";
import { bumpMiningRefresh } from "./mining-refresh.js";
import { NARROW_BREAKPOINT, RADIUS, SPACE } from "./ui-tokens.js";
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
export interface SourcesPanelViewProps {
  /** 数据端口（由 client 入口装配，默认走同 origin REST）。 */
  port: KnowselfProfilePort;
}

/** 错误态种类（与「数据」互斥）。 */
type PanelFailure =
  | { kind: "degraded"; reason: string }
  | { kind: "session" }
  | { kind: "error"; message: string };

/** 一次拉取的资料上限（面板只做首页浏览；分页留给后续波次）。 */
const PAGE_LIMIT = 200;

/** 资料类别 → 中文（`SourceKind` 的三个字面量）。 */
const KIND_LABELS: Readonly<Record<SourceStored["kind"], string>> = {
  file: "文件",
  url: "链接",
  paste: "粘贴文本",
};

/** 资料状态 → 中文（`SourceStatus` 的六个字面量）。 */
const STATUS_LABELS: Readonly<Record<SourceStatus, string>> = {
  raw: "未蒸馏",
  distilling: "蒸馏中",
  pending_review: "待审核",
  completed: "已完成",
  rejected: "已忽略",
  distill_failed: "蒸馏失败",
};

/**
 * 资料状态 → **三态 pill**（本轮 UI 重设计：每行一个状态徽标）。
 *
 * 判定规则（把 6 个精确状态归到 3 个粗粒度视觉档，精确状态仍由 `InfoField 状态` 那一行保留）：
 *   - `completed`           → 已采纳（绿）：蒸馏完成、可被采纳进画像；
 *   - `distill_failed`      → 失败（红）：上次蒸馏报错，`last_error` 里有人可读原因；
 *   - 其余（raw / distilling / pending_review / rejected）→ 待整理（黄）：
 *     还没到「可用」这一步，仍在人工或流水线待处理队列里。
 */
const STATUS_PILL: Readonly<Record<SourceStatus, { kind: "ok" | "pending" | "fail"; label: string }>> = {
  raw: { kind: "pending", label: "待整理" },
  distilling: { kind: "pending", label: "待整理" },
  pending_review: { kind: "pending", label: "待整理" },
  completed: { kind: "ok", label: "已采纳" },
  rejected: { kind: "pending", label: "待整理" },
  distill_failed: { kind: "fail", label: "失败" },
};

/**
 * 资料显示名：优先 `original_name`，其次 `url`，最后 `id` 前 8 位（全是真实字段，不编造）。
 * @param source 资料行
 */
function displayName(source: SourceStored): string {
  if (source.original_name !== "") return source.original_name;
  if (source.url !== null && source.url !== "") return source.url;
  return `（未命名）${source.id.slice(0, 8)}`;
}

/**
 * 资料面板主区视图。
 * 加载流程：`listSources({limit})` + `listProposals("pending")` 并发；后者失败**不致命**
 * （只影响「条目数」一列），主列表语义不因此丢失。
 * W-1：添加资料 / 重新蒸馏成功后递增 `reloadToken` 刷新；写失败只显示局部提示，
 * 不覆盖整页 `failure`（列表数据仍然有效）。
 */
export function SourcesPanelView({ port }: SourcesPanelViewProps): ReactElement {
  const [sources, setSources] = useState<SourceStored[]>([]);
  /** source_id → 待整理提案数；`undefined` 表示聚合数据不可得（显示「—」）。 */
  const [pendingCounts, setPendingCounts] = useState<ReadonlyMap<string, number> | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  /** 重试令牌：递增即重新拉取（降级态重试 / 写操作成功后刷新）。 */
  const [reloadToken, setReloadToken] = useState<number>(0);
  /** W-1：是否展开添加资料表单。 */
  const [showAdd, setShowAdd] = useState<boolean>(false);
  /** W-1：正在重新蒸馏的资料 id（null = 空闲）；同一时刻只允许一个。 */
  const [redistillBusyId, setRedistillBusyId] = useState<string | null>(null);
  /** W-3：行级写操作（改名/删除）的 busy、错误与确认态。 */
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  /** W-1：重新蒸馏的局部错误（不覆盖整页 failure）。 */
  const [redistillError, setRedistillError] = useState<string | null>(null);
  /** 窄屏下展开「⋯」菜单的资料 id（null = 收起）。 */
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
        // 待整理计数是「锦上添花」：单独 catch，失败也不影响主列表。
        const pendingPromise = port
          .listProposals("pending")
          .then((list: IngestionProposal[]) => list)
          .catch((): IngestionProposal[] | undefined => undefined);
        const [list, pending] = await Promise.all([
          port.listSources({ limit: PAGE_LIMIT }),
          pendingPromise,
        ]);
        if (cancelled) return;
        setSources(list);
        if (pending === undefined) {
          setPendingCounts(undefined);
        } else {
          const counts = new Map<string, number>();
          for (const proposal of pending) {
            counts.set(proposal.source_id, (counts.get(proposal.source_id) ?? 0) + 1);
          }
          setPendingCounts(counts);
        }
      } catch (err) {
        if (!cancelled) {
          setFailure(toFailure(err));
          setSources([]);
          setPendingCounts(undefined);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken, toFailure]);

  /** W-1：对一条资料重新蒸馏，成功后刷新列表；失败只写局部提示。 */
  const onRedistill = async (sourceId: string): Promise<void> => {
    if (redistillBusyId !== null) return;
    setRedistillError(null);
    setRedistillBusyId(sourceId);
    try {
      await port.runDistill(sourceId);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setRedistillError(err instanceof Error ? err.message : String(err));
    } finally {
      setRedistillBusyId(null);
    }
  };

  /**
   * W-3：改资料名。空名字本地先拦一次（省一次往返），服务端还会再校验。
   * @param sourceId 资料 id
   * @param current 当前名字（用于判断是否有变化）
   */
  const onRename = async (sourceId: string, current: string): Promise<void> => {
    const next = (draftNames[sourceId] ?? current).trim();
    if (next === "") {
      setRowError({ id: sourceId, message: "名字不能为空" });
      return;
    }
    if (next === current) return;
    setRowBusyId(sourceId);
    setRowError(null);
    try {
      await port.renameSource(sourceId, next);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setRowError({ id: sourceId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRowBusyId(null);
    }
  };

  /**
   * W-3：删除资料。已产出过采纳提案的资料服务端会回 409，这里把原因原样显示，不静默。
   * @param sourceId 资料 id
   */
  const onDelete = async (sourceId: string): Promise<void> => {
    setRowBusyId(sourceId);
    setRowError(null);
    try {
      await port.deleteSource(sourceId);
      setDeleteConfirmId(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setRowError({ id: sourceId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRowBusyId(null);
    }
  };

  const deleteTarget =
    deleteConfirmId === null
      ? null
      : sources.find((source) => source.id === deleteConfirmId) ?? null;

  return (
    <PanelShell
      testId="sources-panel"
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
      <PanelHeading
        title="资料"
        action={
          <button
            type="button"
            data-testid="sources-add-button"
            aria-expanded={showAdd}
            onClick={() => {
              setShowAdd((v) => !v);
              setRedistillError(null);
            }}
            style={{
              cursor: "pointer",
              fontSize: 12,
              padding: SPACE.sm + "px " + SPACE.md + "px",
              border: `1px solid ${PANEL_COLORS.accent}`,
              background: PANEL_COLORS.accent,
              color: "#ffffff",
              borderRadius: RADIUS.pill,
              fontWeight: 600,
            }}
          >
            添加资料
          </button>
        }
      />

      <div
        ref={rootRef}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.xl + "px" }}
      >
        <section
          aria-label="资料接入工作台"
          style={{
            marginBottom: SPACE.xl,
            padding: SPACE.lg,
            border: `1px solid ${PANEL_COLORS.border}`,
            borderRadius: RADIUS.card,
            background: PANEL_COLORS.surface,
            boxShadow: "0 8px 24px rgba(23, 32, 51, 0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: SPACE.md,
              marginBottom: SPACE.lg,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 15, color: PANEL_COLORS.text }}>资料接入工作台</h3>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: SPACE.lg,
              alignItems: "start",
            }}
          >
            <WechatAssistSection />
          </div>
        </section>

        <Modal
          open={showAdd}
          title="添加资料"
          onClose={() => setShowAdd(false)}
          testId="sources-add-modal"
          width={640}
        >
          <SourcesAddForm
            port={port}
            onDone={() => {
              setShowAdd(false);
              setReloadToken((n) => n + 1);
            }}
            // 导入/批量采纳成功后只 bump 共享信号：图谱面板订阅后自己重拉，
            // 资料面板不在这里等图谱数据回来（W-9：显式信号，不做隐式刷新）
            onMiningRefresh={bumpMiningRefresh}
            onCancel={() => setShowAdd(false)}
          />
        </Modal>
        {redistillError !== null && (
          <p
            role="alert"
            data-testid="sources-redistill-error"
            style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}
          >
            重新蒸馏失败：{redistillError}
          </p>
        )}

        {failure !== null && failure.kind === "degraded" && (
          <DegradedNotice
            reason={failure.reason}
            onRetry={() => setReloadToken((n) => n + 1)}
            testId="sources-panel-degraded"
          />
        )}
        {failure !== null && failure.kind === "session" && (
          <SessionExpiredNotice testId="sources-panel-session-expired" />
        )}
        {failure !== null && failure.kind === "error" && (
          <ErrorNotice message={failure.message} testId="sources-panel-error" />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: SPACE.md,
            margin: `${SPACE.xl}px 0 ${SPACE.md}px`,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 15, color: PANEL_COLORS.text }}>资料库</h3>
          </div>
        </div>

        {loading && <LoadingNotice />}
        {!loading && failure === null && sources.length === 0 && (
          <EmptyNotice
            icon="📄"
            text="还没有资料。"
            action={
              <button
                type="button"
                onClick={() => setShowAdd(true)}
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
                新增资料
              </button>
            }
          />
        )}

        {sources.map((source) => {
          const pending = pendingCounts === undefined ? undefined : (pendingCounts.get(source.id) ?? 0);
          const busy = redistillBusyId === source.id;

          /** 重新蒸馏按钮（宽屏行内 / 窄屏进 ⋯ 菜单共用同一份）。 */
          const redistillButton = (
            <button
              type="button"
              data-testid="sources-redistill"
              disabled={redistillBusyId !== null}
              onClick={() => void onRedistill(source.id)}
              style={{
                cursor: redistillBusyId !== null ? "default" : "pointer",
                fontSize: 12,
                padding: `${SPACE.xs}px ${SPACE.sm}px`,
                border: `1px solid ${PANEL_COLORS.border}`,
                background: PANEL_COLORS.surface,
                color: PANEL_COLORS.text,
                borderRadius: RADIUS.control,
              }}
            >
              {busy ? "蒸馏中…" : "重新蒸馏"}
            </button>
          );

          /** 改名 / 删除行（宽屏行内 / 窄屏进 ⋯ 菜单共用同一份）。 */
          const renameRow = (
            <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center", width: "100%" }}>
              <input
                data-testid="source-name-input"
                aria-label="资料名称"
                value={draftNames[source.id] ?? source.original_name}
                onChange={(event) =>
                  setDraftNames((prev) => ({ ...prev, [source.id]: event.target.value }))
                }
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  padding: `${SPACE.xs}px ${SPACE.sm}px`,
                  border: `1px solid ${PANEL_COLORS.border}`,
                  borderRadius: RADIUS.control,
                  fontFamily: "inherit",
                }}
              />
              <button
                type="button"
                data-testid="source-rename"
                disabled={rowBusyId !== null}
                onClick={() => void onRename(source.id, source.original_name)}
                style={{
                  cursor: rowBusyId !== null ? "default" : "pointer",
                  fontSize: 12,
                  padding: `${SPACE.xs}px ${SPACE.sm}px`,
                  border: `1px solid ${PANEL_COLORS.border}`,
                  background: PANEL_COLORS.surface,
                  color: PANEL_COLORS.text,
                  borderRadius: RADIUS.control,
                }}
              >
                改名
              </button>
              <button
                type="button"
                data-testid="source-delete"
                disabled={rowBusyId !== null}
                onClick={() => setDeleteConfirmId(source.id)}
                style={{
                  cursor: rowBusyId !== null ? "default" : "pointer",
                  fontSize: 12,
                  padding: `${SPACE.xs}px ${SPACE.sm}px`,
                  border: `1px solid ${PANEL_COLORS.dangerText}`,
                  background: PANEL_COLORS.surface,
                  color: PANEL_COLORS.dangerText,
                  borderRadius: RADIUS.control,
                }}
              >
                删除
              </button>
            </div>
          );

          return (
            <article
              key={source.id}
              data-testid="sources-panel-item"
              style={{
                border: `1px solid ${PANEL_COLORS.border}`,
                borderRadius: RADIUS.card,
                padding: SPACE.lg,
                marginBottom: SPACE.md,
                background: PANEL_COLORS.surface,
                boxShadow: "0 4px 16px rgba(23, 32, 51, 0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <Avatar name={displayName(source)} size={32} />
                <span
                  title={displayName(source)}
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: PANEL_COLORS.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {displayName(source)}
                </span>
                <Pill kind={STATUS_PILL[source.status].kind}>
                  {STATUS_PILL[source.status].label}
                </Pill>
              </div>
              <div style={{ marginBottom: 6 }}>
                <TagChips tags={[STATUS_LABELS[source.status], KIND_LABELS[source.kind]]} />
              </div>
              <InfoField
                label="类型"
                value={`${KIND_LABELS[source.kind]} · ${source.mime_type}`}
              />
              <InfoField label="状态" value={STATUS_LABELS[source.status]} />
              <InfoField
                label="待整理提案"
                value={
                  pending === undefined
                    ? "—"
                    : pending === 0
                      ? "0 条待整理"
                      : `${pending} 条待整理`
                }
              />
              <InfoField
                label="更新时间"
                value={source.last_ingested_at ?? source.created_at}
              />
              <InfoField label="字符数" value={source.truncated ? `${source.char_count}（已截断）` : source.char_count} />
              {source.user_tags.length === 0 ? null : (
                <InfoField label="标签" value={<TagChips tags={source.user_tags} />} />
              )}
              {source.user_note === "" ? null : <InfoField label="备注" value={source.user_note} />}
              {source.last_error === null ? null : (
                <p
                  style={{
                    fontSize: 12,
                    color: PANEL_COLORS.dangerText,
                    margin: "6px 0 0",
                    ...WRAP_TEXT,
                  }}
                >
                  蒸馏失败：{source.last_error}
                </p>
              )}
              {/* 宽屏：行内按钮；窄屏：收进 ⋯ 菜单（同一组按钮，两种呈现） */}
              {isNarrow ? (
                <div style={{ position: "relative", marginTop: SPACE.sm }}>
                  <button
                    type="button"
                    aria-label="更多操作"
                    aria-expanded={menuOpenId === source.id}
                    onClick={() => setMenuOpenId(menuOpenId === source.id ? null : source.id)}
                    style={{
                      cursor: "pointer",
                      fontSize: 12,
                      padding: `${SPACE.xs}px ${SPACE.sm}px`,
                      border: `1px solid ${PANEL_COLORS.border}`,
                      background: PANEL_COLORS.surface,
                      color: PANEL_COLORS.text,
                      borderRadius: RADIUS.control,
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpenId === source.id && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        marginTop: SPACE.xs,
                        display: "flex",
                        flexDirection: "column",
                        gap: SPACE.sm,
                        padding: SPACE.sm,
                        border: `1px solid ${PANEL_COLORS.border}`,
                        borderRadius: RADIUS.control,
                        background: PANEL_COLORS.surface,
                        boxShadow: "0 8px 24px rgba(0,0,0,.12)",
                        zIndex: 5,
                        width: 260,
                      }}
                    >
                      {redistillButton}
                      {renameRow}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, marginTop: SPACE.sm }}>
                  {redistillButton}
                  {renameRow}
                </div>
              )}

              {rowError !== null && rowError.id === source.id && (
                <p
                  role="alert"
                  data-testid="source-action-error"
                  style={{ fontSize: 12, color: PANEL_COLORS.dangerText, margin: "6px 0 0", ...WRAP_TEXT }}
                >
                  操作失败：{rowError.message}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除资料"
        danger
        busy={rowBusyId !== null}
        message={
          deleteTarget === null
            ? "删除该资料？"
            : <>删除「{displayName(deleteTarget)}」？该资料与其提案将一并移除，<strong>不可撤销</strong>。</>
        }
        confirmLabel="确认删除"
        onCancel={() => setDeleteConfirmId(null)}
        onConfirm={() => {
          if (deleteTarget !== null) void onDelete(deleteTarget.id);
        }}
        testId="source-delete-dialog"
        confirmTestId="source-delete-confirm"
      />
    </PanelShell>
  );
}
