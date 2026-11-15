/**
 * 图谱节点**右键上下文菜单**（Obsidian Graph View 风格）。
 *
 * ## 职责
 * 只做「菜单 + 内联对话框」的展示与交互，写操作通过回调上抛给面板（`graph-panel.tsx`）
 * 再接到 `PersonWritePort`。本组件不 import 写端口：没有端口时 `canWrite=false`，
 * 写动作不渲染，只有「聚焦局部图」仍可用。
 *
 * ## 动作语义（按节点类型分流，与 W29 认领一致）
 *   - person（非未识别）→ 改名 / 合并到… / 归档（删除）/ 聚焦；
 *   - direct / 未识别·person → 认领为人物 / 聚焦（认领复用面板的 `GraphClaimPanel`）；
 *   - group / topic → 聚焦（无写动作）；
 *   - community 超节点 → 不弹本菜单（点击即下钻）。
 *
 * ## 二次确认
 * 合并 / 归档不可撤销 → 必须二次确认（文案写清后果）；失败不许静默（`role="alert"`）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import type { PersonPanelRow } from "./data-port.js";
import type { GraphLayoutNode } from "./graph-layout.js";

/** 右键菜单动作回调集（由面板注入）。 */
export interface GraphContextMenuActions {
  /** 改名（person 节点，异步）。 */
  onRename: (name: string) => Promise<void>;
  /** 合并到目标 person_id（person 节点，异步）。 */
  onMerge: (targetPersonId: string) => Promise<void>;
  /** 归档 / 删除（person 节点，异步）。 */
  onDelete: () => Promise<void>;
  /** 认领为人物（direct / 未识别 person，立即打开面板的认领表单）。 */
  onClaim: () => void;
  /** 合并目标搜索（返回候选人物）。 */
  searchPersons: (keyword: string) => readonly PersonPanelRow[] | Promise<readonly PersonPanelRow[]>;
  /** 关闭菜单。 */
  onClose: () => void;
  /** 是否有写通道（false 时只显示「聚焦」）。 */
  canWrite: boolean;
}

/** 菜单 props。 */
export interface GraphContextMenuProps {
  /** 命中的节点。 */
  node: GraphLayoutNode;
  /** 相对画布舞台的坐标（CSS 像素）。 */
  position: { x: number; y: number };
  /** 动作回调。 */
  actions: GraphContextMenuActions;
}

/** 内联对话框模式。 */
type MenuMode = "menu" | "rename" | "merge" | "delete";

/** 菜单容器样式。 */
const MENU: CSSProperties = {
  position: "absolute",
  zIndex: 5,
  minWidth: 176,
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0,0,0,.12)",
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

/** 菜单项样式。 */
const ITEM: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: "#111827",
  borderRadius: 4,
  padding: "6px 10px",
  fontFamily: "inherit",
};

/** 危险项样式（归档）。 */
const DANGER_ITEM: CSSProperties = { ...ITEM, color: "#b91c1c" };

/** 输入框样式。 */
const INPUT: CSSProperties = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

/** 次要按钮样式。 */
const BTN: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  border: "1px solid #d1d5db",
  background: "#fff",
  borderRadius: 4,
  padding: "3px 10px",
  color: "#111827",
};

/**
 * 右键上下文菜单。
 * @param props 见 {@link GraphContextMenuProps}
 * @returns 菜单元素（含内联对话框）
 */
export function GraphContextMenu({ node, position, actions }: GraphContextMenuProps): ReactElement {
  const [mode, setMode] = useState<MenuMode>("menu");
  const [name, setName] = useState<string>(node.label);
  const [keyword, setKeyword] = useState<string>("");
  const [candidates, setCandidates] = useState<readonly PersonPanelRow[]>([]);
  const [target, setTarget] = useState<PersonPanelRow | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const isPerson = node.kind === "person";
  const needsClaim = node.kind === "direct" || (node.kind === "person" && node.label.startsWith("未识别·"));
  const showWriteActions = isPerson && !needsClaim;

  // 换节点时重置（面板每次右键都会新建菜单，这里兜底防复用）
  useEffect(() => {
    setName(node.label);
    setMode("menu");
    setKeyword("");
    setCandidates([]);
    setTarget(null);
    setFailure(null);
  }, [node.id, node.label]);

  // 合并目标搜索（空关键字不查）
  useEffect(() => {
    if (mode !== "merge" || keyword.trim() === "") {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await Promise.resolve(actions.searchPersons(keyword.trim()));
        if (!cancelled) setCandidates(rows.filter((row) => row.person_id !== node.id).slice(0, 8));
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, keyword, node.id, actions.searchPersons]);

  const openRename = (): void => {
    setMode("rename");
    requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
  };

  /** 统一包一层：置忙、清错、await 回调、失败显红。 */
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      actions.onClose();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const menuItems = useMemo(() => {
    const hasClaim = actions.canWrite && needsClaim;
    const hasWrite = actions.canWrite && showWriteActions;
    if (!hasClaim && !hasWrite) {
      return (
        <span style={{ fontSize: 12, color: "#6b7280", padding: "6px 10px" }}>无可用操作</span>
      );
    }
    return (
      <>
        {hasClaim && (
          <button type="button" data-testid="graph-context-claim" style={ITEM} onClick={actions.onClaim}>
            认领为人物
          </button>
        )}
        {hasWrite && (
          <>
            <button type="button" style={ITEM} onClick={openRename}>
              改名
            </button>
            <button type="button" style={ITEM} onClick={() => setMode("merge")}>
              合并到…
            </button>
            <button type="button" style={DANGER_ITEM} onClick={() => setMode("delete")}>
              归档（删除）
            </button>
          </>
        )}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 回调由面板用 useCallback 固定
  }, [actions, needsClaim, showWriteActions]);

  return (
    <div
      data-testid="graph-context-menu"
      style={{ ...MENU, left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {mode === "menu" && menuItems}

      {mode === "rename" && (
        <div data-testid="graph-context-rename" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
          <input
            data-testid="graph-context-rename-input"
            ref={nameInputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={INPUT}
          />
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button type="button" style={BTN} onClick={() => setMode("menu")}>
              取消
            </button>
            <button
              type="button"
              data-testid="graph-context-rename-confirm"
              disabled={busy || name.trim() === ""}
              style={BTN}
              onClick={() => {
                if (name.trim() !== "") void run(() => actions.onRename(name.trim()));
              }}
            >
              确认
            </button>
          </div>
        </div>
      )}

      {mode === "merge" && (
        <div data-testid="graph-context-merge" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>把「{node.label}」合并到（搜索选择，不可撤销）：</span>
          <input
            data-testid="graph-context-merge-search"
            placeholder="输入名字搜索…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={INPUT}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 160, overflow: "auto" }}>
            {candidates.map((row) => (
              <button
                key={row.person_id}
                type="button"
                data-testid={`graph-context-merge-candidate-${row.person_id}`}
                onClick={() => setTarget(row)}
                aria-pressed={target?.person_id === row.person_id}
                style={{
                  ...ITEM,
                  textAlign: "left",
                  border: `1px solid ${target?.person_id === row.person_id ? "#2563eb" : "#e5e7eb"}`,
                  background: target?.person_id === row.person_id ? "#eff6ff" : "#fff",
                }}
              >
                {row.display_name}
                <span style={{ color: "#6b7280", marginLeft: 6 }}>{row.msg_count} 条消息</span>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button type="button" style={BTN} onClick={() => setMode("menu")}>
              取消
            </button>
            <button
              type="button"
              data-testid="graph-context-merge-confirm"
              disabled={target === null || busy}
              style={BTN}
              onClick={() => {
                if (target !== null) void run(() => actions.onMerge(target.person_id));
              }}
            >
              确认合并
            </button>
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div data-testid="graph-context-delete" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4 }}>
          <span style={{ fontSize: 12, color: "#b91c1c" }}>
            归档「{node.label}」？该人物不再出现在图谱与默认列表，历史消息不会被删除。
          </span>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button type="button" style={BTN} onClick={() => setMode("menu")}>
              取消
            </button>
            <button
              type="button"
              data-testid="graph-context-delete-confirm"
              disabled={busy}
              style={{ ...BTN, borderColor: "#fca5a5", color: "#b91c1c" }}
              onClick={() => void run(actions.onDelete)}
            >
              确认归档
            </button>
          </div>
        </div>
      )}

      {failure !== null && (
        <p role="alert" data-testid="graph-context-error" style={{ fontSize: 12, color: "#b91c1c", margin: "4px 6px" }}>
          操作失败：{failure}
        </p>
      )}
    </div>
  );
}
