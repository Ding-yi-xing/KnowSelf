/**
 * A2-1 人物档案面板（React 组件）。
 *
 * 纯展示 / 编排层：人物列表（双栏布局）+ 选中人物档案（`PersonRow` 字段 + 事件时间线）。
 * 数据来源**只经 `PersonPanelDataPort`**（props 注入），不 import `@knowself/person-store`
 * 的运行时实现（浏览器无法直连 better-sqlite3）。
 *
 * 依赖：仅 React 18（根 node_modules 提供，dsh web 打包器注入）。不引入任何 UI 组件库。
 *
 * §13.4：宿主人物层降级时 REST 端口抛 `PersonLayerDegradedError`（503）。本面板据此
 * 显示「数据层未就绪：<reason>」并保留重试按钮，与通用错误态区分。
 *
 * ## 本轮 UI 重设计（对照 `docs/dsh-integration/ui-redesign-proposal.html`）
 * 1. **双栏**：左 = 搜索 + 人物卡列表（头像 / 名字 / `消息数 · 最近时间` + 关系强度条），
 *    右 = 选中人详情（大头像 / 消息·会话统计 / 备注标签 / 最近互动时间线 / 改名·合并·归档）。
 * 2. **关系强度**：按 `msg_count` 归一化成条宽 + 一个词（核心 / 亲密 / 常联系 / 熟识 / 待认领），
 *    阈值见 `strengthOf`。
 * 3. **响应式**：容器宽 < 480px 时双栏折叠成单栏，详情栏改为**点人后覆盖显示**（见 `isNarrow`）。
 *
 * ## 列表行交互契约（评审可逐条对照）
 * - 每行卡片 hover / 键盘 focus 时出现行内操作（`:focus-within`，不是 JS `onMouseEnter`）；
 * - 长名单行截断 + `title`（真实数据有 `23计应1吴成忠13859092020`）；
 * - 计数类数字 `tabular-nums`。
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type {
  PersonPanelDataPort,
  PersonPanelEvent,
  PersonTimelineResult,
  PersonPanelRow,
} from "./data-port.js";
import { PersonActions } from "./person-actions.js";
import { CardText, EmptyState, PanelShell, SkeletonList, useContainerWidth } from "./ui-kit.js";
import {
  COLORS,
  NARROW_BREAKPOINT,
  ONE_LINE,
  PRIMARY_BUTTON,
  RADIUS,
  SECONDARY_BUTTON,
  SPACE,
  TABULAR,
  TYPE,
  initialOf,
} from "./ui-tokens.js";
import type { PersonWritePort } from "./person-write-port.js";
import { PersonLayerDegradedError } from "./rest-data-port.js";
import { consumeFocusedPerson, subscribeFocusedPerson } from "./panel-jump.js";
import { GroupDirectoryView } from "./group-directory.js";

/** 组件 props。 */
export interface PersonPanelViewProps {
  /** W-3：写端口（新建/改名/备注/合并/归档）。缺省不渲染编辑区。 */
  writePort?: PersonWritePort;
  /** 只读数据端口（由 client 入口从 ctx / 宿主装配注入）。 */
  port: PersonPanelDataPort;
  /** 数据桥接是否已配置；false 时显示诚实提示而非伪造数据。 */
  bridgeReady: boolean;
  /** 空态主按钮「导入聊天记录」的回调（index.tsx 注入：切到资料面板）。 */
  onImportChat?: () => void;
}

/** 列表默认上限 / 时间线默认上限。 */
const LIST_LIMIT = 200;
const TIMELINE_LIMIT = 50;

/** 行内头像直径（清单要求 32px）。 */
const ROW_AVATAR_SIZE = 32;
/** 详情大头像直径（设计稿 44px）。 */
const DETAIL_AVATAR_SIZE = 44;
/** 空态图标尺寸（清单要求 40×40）。 */
const EMPTY_ICON_SIZE = 40;

/** 行内「改名 / 合并 / 删除」按钮样式（复用 `SECONDARY_BUTTON`）。 */
const ROW_ACTION_BTN: CSSProperties = SECONDARY_BUTTON;
const ROW_ACTION_BTN_DANGER: CSSProperties = {
  ...SECONDARY_BUTTON,
  color: COLORS.danger,
  borderColor: COLORS.dangerBorder,
};

/**
 * 行内头像的 6 档底色 —— **全部由 `ui-tokens` 既有色派生，不新增硬编码色值**。
 * 两种派生手法：直接引用 token + 叠一层黑色半透明压明度。
 * 第 6 档把 `subtle`（#6b7280，对白字约 4.1:1 不达标）叠 18% 黑到约 #575e66（约 5.5:1）才敢用。
 */
interface AvatarTint {
  readonly base: string;
  readonly darken: number;
}

const ROW_AVATAR_TINTS: readonly AvatarTint[] = [
  { base: COLORS.accent, darken: 0 },
  { base: COLORS.danger, darken: 0 },
  { base: COLORS.warnText, darken: 0 },
  { base: COLORS.muted, darken: 0 },
  { base: COLORS.text, darken: 0 },
  { base: COLORS.subtle, darken: 0.18 },
];

/** 由名字取一个稳定的头像底色（31 进制 hash，同名恒同色）。 */
function rowAvatarTint(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  const tint = ROW_AVATAR_TINTS[hash % ROW_AVATAR_TINTS.length] as AvatarTint;
  if (tint.darken === 0) return tint.base;
  return `linear-gradient(rgba(0, 0, 0, ${tint.darken}), rgba(0, 0, 0, ${tint.darken})), ${tint.base}`;
}

/** 圆形首字头像（列表 32 / 详情 44 两处复用）。 */
function RowAvatar({ name, size }: { name: string; size: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: RADIUS.pill,
        background: rowAvatarTint(name),
        color: COLORS.surface,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.44),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {initialOf(name)}
    </span>
  );
}

/** 标准 sr-only 视觉隐藏（不用 display:none / visibility:hidden）。 */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * 列表卡片与行内操作的样式表（只注入一次）。
 * 注意：不写任何中文——`<style>` 会进 `container.textContent`，混中文会误伤既有断言。
 */
const ROW_CSS = `
[data-ks-panel] .ks-person-row {
  position: relative;
  display: flex;
  align-items: center;
  padding: ${SPACE.md}px;
  border: 1px solid ${COLORS.border};
  border-radius: ${RADIUS.card}px;
  background: ${COLORS.surface};
  box-shadow: 0 1px 1px rgba(23, 32, 51, 0.02);
  transition: background-color 120ms ease, border-color 120ms ease;
}
[data-ks-panel] .ks-person-row:hover { background: ${COLORS.hover}; border-color: ${COLORS.borderStrong}; box-shadow: 0 6px 16px rgba(23, 32, 51, 0.06); }
[data-ks-panel] .ks-person-row:focus-within { background: ${COLORS.hover}; border-color: ${COLORS.accent}; }
[data-ks-panel] .ks-person-row[data-active="true"] {
  border-color: ${COLORS.accent};
  background: ${COLORS.accentSoft};
  box-shadow: inset 3px 0 0 ${COLORS.accent};
}
[data-ks-panel] .ks-person-row-actions {
  position: absolute;
  top: 50%;
  right: ${SPACE.sm}px;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: ${SPACE.xs}px;
  padding-left: ${SPACE.sm}px;
  border-radius: ${RADIUS.control}px;
  background: ${COLORS.surface};
  opacity: 0;
  transition: opacity 120ms ease;
}
[data-ks-panel] .ks-person-row:hover .ks-person-row-actions,
[data-ks-panel] .ks-person-row:focus-within .ks-person-row-actions {
  opacity: 1;
  background: ${COLORS.hover};
}
[data-ks-panel] .ks-person-row[data-active="true"] .ks-person-row-actions,
[data-ks-panel] .ks-person-row[data-active="true"]:focus-within .ks-person-row-actions {
  background: ${COLORS.accentSoft};
}
@media (prefers-reduced-motion: reduce) {
  [data-ks-panel] .ks-person-row,
  [data-ks-panel] .ks-person-row-actions { transition: none; }
}
`;

/** 行内按钮要求的动作种类（列表 → 右侧操作区）。 */
type RowActionKind = "rename" | "merge" | "delete";

/** 一次行内操作请求（带递增 token，让「连点同一按钮」每次都能重新触发 effect）。 */
interface RowActionRequest {
  readonly kind: RowActionKind;
  readonly personId: string;
  readonly token: number;
}

/** 把 `last_msg_at` 压成侧栏能放下的短时间（同年省略年份，jsdom 下也稳定）。 */
function formatRecentMessageAt(iso: string | null): string {
  if (iso === null || iso === "") return "无消息";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() !== new Date().getFullYear()) {
    return `${date.getFullYear()}-${monthDay}`;
  }
  return `${monthDay} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 列表行第二行文案：`消息数 · 最近时间`（只算直聊；群消息不计入个人档案）。 */
function formatRowMeta(row: PersonPanelRow): string {
  const msgs = row.direct_msg_count ?? row.msg_count;
  if (msgs === 0) return "无直聊消息";
  const recent = formatRecentMessageAt(row.direct_last_msg_at ?? row.last_msg_at);
  if (recent === "无消息") return `${msgs} 条直聊消息`;
  return `${msgs} 条直聊消息 · ${recent}`;
}

/** 备注字符串 → 标签数组（分隔符：中英文逗号 / 顿号 / 分号 / 换行；空串过滤）。 */
function splitTags(remark: string): string[] {
  return remark
    .split(/[,，、;；\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * 关系强度：按 `msg_count` 给一个词 + 一条相对条宽。
 *
 * 阈值（**自定**，基于 2026-11 真实数据量级：我 33915 / 宝宝 9235 / 黄危杰 9046 / 巴恩奇 7862）：
 *   - 核心   ≥ 10000
 *   - 亲密   ≥ 9200
 *   - 常联系 ≥ 8000
 *   - 熟识   ≥ 100
 *   - 待认领 < 100，或名字以「未识别」开头（未认领的机器占位档案）
 *
 * @param row 人物行
 * @param maxMsgs 当前列表里最大消息数（条宽归一化基准）
 */
function strengthOf(row: PersonPanelRow, maxMsgs: number): { label: string; widthPct: number } {
  const msgs = row.direct_msg_count ?? row.msg_count;
  let label: string;
  if (row.display_name.startsWith("未识别") || msgs < 100) label = "待认领";
  else if (msgs >= 10000) label = "核心";
  else if (msgs >= 9200) label = "亲密";
  else if (msgs >= 8000) label = "常联系";
  else label = "熟识";

  const widthPct = msgs <= 0 ? 4 : Math.max(4, Math.round((msgs / Math.max(maxMsgs, 1)) * 100));
  return { label, widthPct };
}

/** 空态图标：人物剪影（内联 SVG，40×40）。 */
function PersonEmptyIcon(): ReactElement {
  return (
    <svg
      width={EMPTY_ICON_SIZE}
      height={EMPTY_ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ color: COLORS.borderStrong }}
    >
      <circle cx="12" cy="8" r="3.75" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.75 20c0-3.45 3.25-5.75 7.25-5.75s7.25 2.3 7.25 5.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 人物档案面板主区视图。
 * 加载流程：listPersons → 选中 → getPerson + timeline；卸载时以 `cancelled` 取消挂起更新。
 */
export function PersonPanelView({
  port,
  bridgeReady,
  writePort,
  onImportChat,
}: PersonPanelViewProps): ReactElement {
  const [persons, setPersons] = useState<PersonPanelRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonPanelRow | null>(null);
  const [timeline, setTimeline] = useState<PersonTimelineResult>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);
  const [rowRequest, setRowRequest] = useState<RowActionRequest | null>(null);
  /** 搜索关键字（本地过滤 display_name / 备注）。 */
  const [query, setQuery] = useState<string>("");
  /** 目录页签：联系人（仅直聊）/ 群聊（单列）。 */
  const [tab, setTab] = useState<"contacts" | "groups">("contacts");
  /** 备注标签的编辑态。 */
  const [tagDraft, setTagDraft] = useState<string>("");
  const [tagBusy, setTagBusy] = useState<boolean>(false);
  const [tagError, setTagError] = useState<string | null>(null);
  /** 响应式：容器宽度（jsdom 下 Infinity = 宽屏）。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerWidth = useContainerWidth(rootRef);
  const isNarrow = containerWidth < NARROW_BREAKPOINT;

  // 跨面板跳转（W-2）：图谱点人 → 这里选中（订阅式，与是否 render 无关）。
  useEffect(() => {
    const pending = consumeFocusedPerson();
    if (pending !== null) setSelectedId(pending);
    const unsubscribe = subscribeFocusedPerson((personId) => setSelectedId(personId));
    return () => {
      unsubscribe();
    };
  }, []);

  // 人物列表
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      setDegradedReason(null);
      try {
        const rows = await Promise.resolve(port.listPersons({ limit: LIST_LIMIT, direct_only: true }));
        if (!cancelled) setPersons(rows);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof PersonLayerDegradedError) {
            setDegradedReason(err.reason);
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : String(err));
            setDegradedReason(null);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, reloadToken]);

  // 选中人物档案 + 事件时间线
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setTimeline([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [person, events] = await Promise.all([
          Promise.resolve(port.getPerson(selectedId)),
          Promise.resolve(port.timeline(selectedId, { limit: TIMELINE_LIMIT })),
        ]);
        if (!cancelled) {
          setDetail(person);
          setTimeline(events);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [port, selectedId]);

  const requestRowAction = (personId: string, kind: RowActionKind): void => {
    setSelectedId(personId);
    setRowRequest((previous) => ({ kind, personId, token: (previous?.token ?? 0) + 1 }));
  };

  /** 只有「请求指向当前详情里那个人」时才把请求转给操作区（防止点 A 弹 B 的对话框）。 */
  const requestedAction =
    rowRequest !== null && detail !== null && rowRequest.personId === detail.person_id
      ? rowRequest
      : null;

  /** 备注标签：加一个。 */
  const addTag = async (): Promise<void> => {
    const next = tagDraft.trim();
    if (next === "" || writePort === undefined || detail === null) return;
    if (splitTags(detail.remark).includes(next)) {
      setTagDraft("");
      return;
    }
    const tags = splitTags(detail.remark).concat(next);
    setTagBusy(true);
    setTagError(null);
    try {
      await writePort.updatePerson(detail.person_id, { note: tags.join("，") });
      setTagDraft("");
      setReloadToken((n) => n + 1);
    } catch (err) {
      setTagError(err instanceof Error ? err.message : String(err));
    } finally {
      setTagBusy(false);
    }
  };

  /** 备注标签：删一个。 */
  const removeTag = async (tag: string): Promise<void> => {
    if (writePort === undefined || detail === null) return;
    const tags = splitTags(detail.remark).filter((item) => item !== tag);
    setTagBusy(true);
    setTagError(null);
    try {
      await writePort.updatePerson(detail.person_id, { note: tags.join("，") });
      setReloadToken((n) => n + 1);
    } catch (err) {
      setTagError(err instanceof Error ? err.message : String(err));
    } finally {
      setTagBusy(false);
    }
  };

  // 本地过滤（搜索框只影响渲染，不发请求）。
  const trimmedQuery = query.trim().toLowerCase();
  const visiblePersons =
    trimmedQuery === ""
      ? persons
      : persons.filter(
          (person) =>
            person.display_name.toLowerCase().includes(trimmedQuery) ||
            person.remark.toLowerCase().includes(trimmedQuery),
        );
  const maxMsgs = persons.reduce(
    (max, person) => Math.max(max, person.direct_msg_count ?? person.msg_count),
    0,
  );

  /** 详情栏内容（宽屏内联 / 窄屏覆盖两处复用同一份）。 */
  const renderDetail = (person: PersonPanelRow): ReactElement => {
    const tags = splitTags(person.remark);
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.md, marginBottom: SPACE.lg }}>
          <RowAvatar name={person.display_name} size={DETAIL_AVATAR_SIZE} />
          <div style={{ minWidth: 0 }}>
            <div style={{ ...TYPE.panelTitle, ...ONE_LINE }} title={person.display_name}>
              {person.display_name}
            </div>
            <div style={{ ...TYPE.meta, color: COLORS.subtle, ...ONE_LINE }}>
              {person.person_id}
              {person.manual_locked ? " · 手动锁定" : ""}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: SPACE.sm,
            marginBottom: SPACE.lg,
          }}
        >
          <div
            style={{
              background: COLORS.surfaceAlt,
              borderRadius: RADIUS.card,
              padding: SPACE.md,
            }}
          >
            <b style={{ display: "block", fontSize: 18, ...TABULAR }}>{person.direct_msg_count ?? person.msg_count}</b>
            <span style={{ fontSize: 11, color: COLORS.subtle }}>直聊消息</span>
          </div>
          <div
            style={{
              background: COLORS.surfaceAlt,
              borderRadius: RADIUS.card,
              padding: SPACE.md,
            }}
          >
            <b style={{ display: "block", fontSize: 18, ...TABULAR }}>{person.direct_conv_count ?? person.conv_count}</b>
            <span style={{ fontSize: 11, color: COLORS.subtle }}>直聊会话</span>
          </div>
        </div>

        <h3 style={{ ...TYPE.section, margin: `0 0 ${SPACE.sm}px` }}>备注与标签</h3>
        <div style={{ marginBottom: SPACE.lg }}>
          {tags.length === 0 ? (
            <span style={{ fontSize: 13, color: COLORS.subtle }}>暂无标签</span>
          ) : (
            tags.map((tag) => (
              <span
                key={tag}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: SPACE.xs,
                  fontSize: 11,
                  lineHeight: 1.6,
                  padding: `0 ${SPACE.sm}px`,
                  borderRadius: RADIUS.pill,
                  background: COLORS.accentSoft,
                  color: COLORS.accent,
                  marginRight: SPACE.xs,
                  marginBottom: SPACE.xs,
                }}
              >
                {tag}
                {writePort !== undefined && (
                  <button
                    type="button"
                    data-testid={`person-tag-remove-${tag}`}
                    aria-label={`删除标签 ${tag}`}
                    disabled={tagBusy}
                    onClick={() => void removeTag(tag)}
                    style={{
                      cursor: tagBusy ? "default" : "pointer",
                      border: "none",
                      background: "transparent",
                      color: "inherit",
                      padding: 0,
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))
          )}
          {writePort !== undefined && (
            <input
              data-testid="person-tag-add"
              value={tagDraft}
              disabled={tagBusy}
              placeholder="＋ 添加标签"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addTag();
              }}
              style={{
                display: "inline-block",
                width: 120,
                fontSize: 11,
                padding: `0 ${SPACE.sm}px`,
                lineHeight: 1.8,
                border: `1px dashed ${COLORS.borderStrong}`,
                borderRadius: RADIUS.pill,
                background: "transparent",
                color: COLORS.text,
                fontFamily: "inherit",
              }}
            />
          )}
          {tagError !== null && (
            <p role="alert" style={{ fontSize: 12, color: COLORS.danger, marginTop: SPACE.xs }}>
              标签操作失败：{tagError}
            </p>
          )}
        </div>

        <h3 style={{ ...TYPE.section, margin: `0 0 ${SPACE.sm}px` }}>最近互动</h3>
        {timeline.length === 0 ? (
          <EmptyState icon="🗓" text="暂无互动记录。" testId="person-timeline-empty" />
        ) : (
          <ol
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              borderLeft: `1px solid ${COLORS.border}`,
              marginLeft: SPACE.sm,
            }}
          >
            {timeline.map((interaction) => {
              const isMessage = "message_id" in interaction;
              return (
              <li
                key={isMessage ? interaction.message_id : interaction.event_id}
                style={{ position: "relative", padding: `0 0 ${SPACE.lg}px ${SPACE.lg}px` }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: -4,
                    top: 5,
                    width: 7,
                    height: 7,
                    borderRadius: RADIUS.pill,
                    background: COLORS.borderStrong,
                  }}
                />
                <div style={{ fontSize: 11, color: COLORS.subtle, ...TABULAR }}>
                  {isMessage
                    ? `${interaction.msg_date} · 消息互动 · ${interaction.sender_name || interaction.role}`
                    : `${interaction.event_date} · ${interaction.title}`}
                </div>
                {(isMessage ? interaction.content : interaction.summary) !== "" && (
                  <div style={{ fontSize: 12, color: COLORS.muted }}>
                    {isMessage ? interaction.content : interaction.summary}
                  </div>
                )}
              </li>
              );
            })}
          </ol>
        )}

        {writePort !== undefined && (
          <PersonActions
            person={person}
            writePort={writePort}
            searchPersons={(keyword) => port.listPersons({ keyword, limit: 8 })}
            requestedAction={requestedAction}
            onChanged={(nextId) => {
              setSelectedId(nextId);
              setReloadToken((n) => n + 1);
            }}
          />
        )}
      </>
    );
  };

  return (
    <PanelShell
      style={{
        display: "flex",
        height: "100%",
        fontFamily: "system-ui, sans-serif",
        color: COLORS.text,
        background: COLORS.surfaceAlt,
      }}
    >
      <style>{ROW_CSS}</style>

      <div
        ref={rootRef}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: SPACE.lg,
          padding: SPACE.xl,
        }}
      >
        {/* 顶部：标题 + 搜索 */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: SPACE.lg,
            flexShrink: 0,
            padding: `${SPACE.lg}px ${SPACE.xl}px`,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.card,
            background: COLORS.surface,
            boxShadow: "0 4px 18px rgba(23, 32, 51, 0.04)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ ...TYPE.panelTitle, margin: 0, fontSize: 22 }}>
              人物档案 <span style={{ ...TYPE.meta, color: COLORS.accent, fontWeight: 700 }}>{persons.length}</span>
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
            <div role="tablist" aria-label="人物目录切换" style={{ display: "flex", gap: 2, padding: 2, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.pill, background: COLORS.surfaceAlt }}>
              {(["contacts", "groups"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  data-testid={`person-tab-${item}`}
                  onClick={() => setTab(item)}
                  style={{
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 12,
                    padding: `${SPACE.xs}px ${SPACE.md}px`,
                    border: "none",
                    borderRadius: RADIUS.pill,
                    background: tab === item ? COLORS.surface : "transparent",
                    color: tab === item ? COLORS.text : COLORS.subtle,
                    fontWeight: tab === item ? 600 : 400,
                    boxShadow: tab === item ? "0 1px 3px rgba(23,32,51,0.08)" : "none",
                  }}
                >
                  {item === "contacts" ? "联系人" : "群聊"}
                </button>
              ))}
            </div>
            <input
              data-testid="person-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名字 / 备注"
              style={{
                width: 220,
                maxWidth: "40vw",
                fontSize: 13,
                padding: `${SPACE.sm}px ${SPACE.md}px`,
                border: `1px solid ${COLORS.borderStrong}`,
                borderRadius: RADIUS.pill,
                fontFamily: "inherit",
                color: COLORS.text,
              }}
            />
          </div>
        </header>

        {!bridgeReady && (
          <div
            role="status"
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: COLORS.warnText,
              background: "#fef3c7",
              border: `1px solid ${COLORS.warnBorder}`,
              borderRadius: RADIUS.control,
              padding: SPACE.sm,
              flexShrink: 0,
            }}
          >
            数据桥接待接入：浏览器面板无法直连 person-store（better-sqlite3 为 Node 原生模块）。
            当前显示空数据；宿主侧需通过 REST / bridge 注入 PersonPanelDataPort。
          </div>
        )}
        {degradedReason !== null && (
          <div
            role="alert"
            data-testid="person-layer-degraded"
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: COLORS.warnText,
              background: COLORS.warnBg,
              border: `1px solid ${COLORS.warnBorder}`,
              borderRadius: RADIUS.control,
              padding: SPACE.sm,
              flexShrink: 0,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: SPACE.sm }}>
              数据层未就绪：{degradedReason}
            </div>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              style={{
                cursor: "pointer",
                fontSize: 12,
                border: "1px solid #d97706",
                background: COLORS.surface,
                color: COLORS.warnText,
                borderRadius: RADIUS.control,
                padding: `${SPACE.xs}px ${SPACE.sm}px`,
              }}
            >
              重试
            </button>
          </div>
        )}
        {error !== null && (
          <p role="alert" style={{ fontSize: 12, color: COLORS.danger, margin: 0, flexShrink: 0 }}>
            数据读取失败：{error}
          </p>
        )}

        {/* 主体：联系人（左列表 + 右详情）/ 群聊（单独目录与消息） */}
        {tab === "groups" ? (
          <GroupDirectoryView port={port} />
        ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: isNarrow ? "1fr" : "minmax(0, 1fr) minmax(300px, 0.56fr)",
            gap: 0,
            alignItems: "stretch",
            overflow: "hidden",
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.card,
            background: COLORS.surface,
            boxShadow: "0 8px 28px rgba(23, 32, 51, 0.05)",
          }}
        >
          {/* 左：人物列表 */}
          <div style={{ minHeight: 0, overflowY: "auto", height: "100%", padding: SPACE.md }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: SPACE.md,
                padding: `${SPACE.xs}px ${SPACE.sm}px ${SPACE.md}px`,
              }}
            >
              <div>
                <div style={{ ...TYPE.section, marginTop: SPACE.xs }}>联系人目录</div>
              </div>
              <span style={{ ...TYPE.meta, color: COLORS.subtle }}>{visiblePersons.length} 位联系人</span>
            </div>
            {loading && <SkeletonList rows={6} testId="person-loading" />}
            {!loading && visiblePersons.length === 0 && (
              <div
                data-testid="person-empty"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: SPACE.md,
                  padding: `${SPACE.xl}px ${SPACE.md}px`,
                  textAlign: "center",
                  minHeight: 240,
                }}
              >
                <PersonEmptyIcon />
                <span style={{ ...TYPE.body, color: COLORS.muted }}>还没有人物档案</span>
                {/* 既有断言 textContent 需含「暂无人物数据」（client-panel-boundary 5 处），sr-only 保留 */}
                <span style={SR_ONLY}>暂无人物数据。</span>
                <button
                  type="button"
                  data-testid="person-empty-import"
                  style={PRIMARY_BUTTON}
                  disabled={onImportChat === undefined}
                  title={onImportChat === undefined ? "尚未接线" : undefined}
                  onClick={() => {
                    if (onImportChat !== undefined) onImportChat();
                  }}
                >
                  导入聊天记录
                </button>
              </div>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {visiblePersons.map((person) => {
                const active = person.person_id === selectedId;
                const strength = strengthOf(person, maxMsgs);
                return (
                  <li
                    key={person.person_id}
                    data-testid="person-row"
                    style={{ marginBottom: SPACE.sm }}
                  >
                    <div className="ks-person-row" data-active={active ? "true" : "false"}>
                      <button
                        type="button"
                        aria-pressed={active}
                        title={person.display_name}
                        onClick={() => setSelectedId(person.person_id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: SPACE.md,
                          flex: 1,
                          minWidth: 0,
                          padding: 0,
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          color: "inherit",
                          font: "inherit",
                          textAlign: "left",
                        }}
                      >
                        <RowAvatar name={person.display_name} size={ROW_AVATAR_SIZE} />
                        <CardText title={person.display_name} meta={formatRowMeta(person)} />
                      </button>
                      {/* 关系强度条 + 词（宽度 ∝ 消息数，见 strengthOf） */}
                      <span
                        style={{
                          width: 56,
                          flexShrink: 0,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: SPACE.xs,
                          paddingLeft: SPACE.sm,
                        }}
                      >
                        <span
                          style={{
                            width: "100%",
                            height: 4,
                            borderRadius: 2,
                            background: COLORS.border,
                            display: "block",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              borderRadius: 2,
                              background: COLORS.accent,
                              width: `${strength.widthPct}%`,
                            }}
                          />
                        </span>
                        <span style={{ fontSize: 10, color: COLORS.subtle, ...TABULAR }}>
                          {strength.label}
                        </span>
                      </span>
                      {writePort !== undefined && (
                        <div className="ks-person-row-actions">
                          <button
                            type="button"
                            data-testid={`person-row-rename-${person.person_id}`}
                            title="改名"
                            onClick={() => requestRowAction(person.person_id, "rename")}
                            style={ROW_ACTION_BTN}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            data-testid={`person-row-merge-${person.person_id}`}
                            title="合并"
                            onClick={() => requestRowAction(person.person_id, "merge")}
                            style={ROW_ACTION_BTN}
                          >
                            合并
                          </button>
                          <button
                            type="button"
                            data-testid={`person-row-delete-${person.person_id}`}
                            title="删除"
                            onClick={() => requestRowAction(person.person_id, "delete")}
                            style={ROW_ACTION_BTN_DANGER}
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* 右：详情（宽屏内联；窄屏不渲染，改用下方覆盖层） */}
          {!isNarrow && (
            <section
              data-testid="person-detail"
              style={{
                minHeight: 0,
                overflowY: "auto",
                height: "100%",
                padding: SPACE.xl,
                background: COLORS.surfaceAlt,
                borderLeft: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ paddingBottom: SPACE.md, marginBottom: SPACE.lg, borderBottom: `1px solid ${COLORS.border}` }}>
                <div style={{ ...TYPE.section, marginTop: SPACE.xs }}>关系档案</div>
              </div>
              {detail === null ? (
                <EmptyState
                  icon="🗂"
                  text="从左侧选择一个人物查看档案。"
                  testId="person-detail-empty"
                />
              ) : (
                renderDetail(detail)
              )}
            </section>
          )}
        </div>
        )}
      </div>

      {/* 窄屏：点人后详情覆盖显示（覆盖列表），带返回按钮 */}
      {tab === "contacts" && isNarrow && detail !== null && (
        <div
          data-testid="person-detail"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            background: COLORS.surface,
            overflowY: "auto",
            padding: SPACE.lg,
          }}
        >
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            style={{ ...SECONDARY_BUTTON, marginBottom: SPACE.md }}
          >
            ‹ 返回列表
          </button>
          {renderDetail(detail)}
        </div>
      )}
    </PanelShell>
  );
}
