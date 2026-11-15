/**
 * 人物档案的**操作区**（W-3 批次 1）：改名 / 加备注 / 合并到… / 归档。
 *
 * ## 为什么单独成组件
 * `person-panel.tsx` 是 328 行的只读实现（列表 + 详情 + 时间线），且被既有测试锁定。
 * 把 CRUD 的对话框、确认文案、失败提示全塞进去会突破行数纪律，也让"只读路径 diff 为零"失效。
 * 这里只负责**交互与文案**，落库全走 `PersonWritePort`。
 *
 * ## 三条产品约束（来自用户原话「恢复完整增删改查」）
 *   1. 合并要**搜索选目标**，不许手填 id —— 人手抄 UUID 一定会抄错；
 *   2. 删除/合并必须**二次确认**，且文案要写清后果（"不可撤销""N 条消息归到 X"）；
 *   3. 失败**不许静默**：`role="alert"` 显示可读原因（后端错误码原样带出）。
 *
 * ## 关于「删除」
 * 后端是**归档**（`status='archived'`），不是物理删除。文案必须与之一致，
 * 否则用户会以为数据没了（实际还在，只是不再参与分析）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { PersonPanelRow } from "./data-port.js";
import type { PersonWritePort } from "./person-write-port.js";

/** 行内按钮能要求本组件打开的动作。 */
export type PersonActionRequestKind = "rename" | "merge" | "delete";

/** 一次「列表行内按钮要求操作区做点什么」的请求。 */
export interface PersonActionRequest {
  /** 要打开的动作。 */
  readonly kind: PersonActionRequestKind;
  /**
   * 请求序号。同一个按钮连点两次时，只传 `kind` 的话 prop 没变、effect 不会重跑，
   * 对话框被关掉后就再也打不开；`token` 递增保证每次点击都产生新对象。
   */
  readonly token?: number;
}

/** 组件 props。 */
export interface PersonActionsProps {
  /** 当前选中的人物（写操作的受体）。 */
  person: PersonPanelRow;
  /** 写端口（由面板注入；缺省则不渲染本组件）。 */
  writePort: PersonWritePort;
  /** 合并目标搜索（复用只读端口，避免再造一个查询端点）。 */
  searchPersons: (keyword: string) => readonly PersonPanelRow[] | Promise<readonly PersonPanelRow[]>;
  /** 写成功后回调（面板据此刷新列表与详情）。 */
  onChanged: (personId: string | null) => void;
  /**
   * 列表行内「改名 / 合并 / 删除」投递过来的动作请求（可选，缺省 null）。
   *
   * 行内按钮在 260px 侧栏里点一下就该直接看到结果，而不是「选中了、然后自己去右边找
   * 那个输入框」。合并/删除直接打开二次确认对话框；改名把焦点移到显示名输入框并全选。
   * **不改变任何既有行为**：不传这个 prop 时表现与之前逐字一致。
   */
  requestedAction?: PersonActionRequest | null;
}

/** 输入框样式（与面板其它输入一致）。 */
const INPUT: React.CSSProperties = {
  fontSize: 13,
  padding: "4px 6px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontFamily: "inherit",
};

/** 按钮样式。 */
const BTN: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  border: "1px solid #d1d5db",
  background: "#fff",
  borderRadius: 4,
  padding: "4px 10px",
  color: "#111827",
};

/**
 * 人物操作区。
 * @param props 见 {@link PersonActionsProps}
 * @returns 操作区元素
 */
export function PersonActions({
  person,
  writePort,
  searchPersons,
  onChanged,
  requestedAction = null,
}: PersonActionsProps): ReactElement {
  const [name, setName] = useState<string>(person.display_name);
  const [note, setNote] = useState<string>(person.remark);
  const [busy, setBusy] = useState<boolean>(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** 当前打开的确认对话框（null = 未打开）。 */
  const [dialog, setDialog] = useState<null | "merge" | "delete">(null);
  const [keyword, setKeyword] = useState<string>("");
  const [candidates, setCandidates] = useState<readonly PersonPanelRow[]>([]);
  const [target, setTarget] = useState<PersonPanelRow | null>(null);
  /** 图谱刷新提示（写成功后后端排队重算；**不代表已完成**）。 */
  const [graphRefreshing, setGraphRefreshing] = useState<boolean>(false);
  /** 手动重试失败的原因（后端那次后台刷新失败是推不回来的，只能靠手动出口）。 */
  const [graphRefreshError, setGraphRefreshError] = useState<string | null>(null);
  /** 显示名输入框（行内「改名」按钮把焦点送到这里）。 */
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 换人时把输入框同步到新人物（否则会拿着上一个人的名字去改下一个人）
  useEffect(() => {
    setName(person.display_name);
    setNote(person.remark);
    setFailure(null);
    setDialog(null);
    setTarget(null);
    setKeyword("");
    setGraphRefreshing(false);
    setGraphRefreshError(null);
  }, [person.person_id, person.display_name, person.remark]);

  // 列表行内按钮（改名 / 合并 / 删除）→ 把动作落到本操作区。
  //
  // 声明在「换人时重置」那个 effect **之后**：同一次 commit 里两个 effect 都跑时，
  // 先由上面把 dialog 清成 null，再由这里把目标对话框打开，顺序反过来会把刚打开的
  // 对话框立刻关掉（这正是这个 effect 必须排在后面的原因）。
  //
  // 依赖只有 `requestedAction` 的引用：面板每点一次都会换新对象（带递增 token），
  // 所以「关掉对话框 → 再点同一个按钮」仍然会重新打开。
  useEffect(() => {
    if (requestedAction === null) return;
    if (requestedAction.kind === "merge") {
      setDialog("merge");
      return;
    }
    if (requestedAction.kind === "delete") {
      setDialog("delete");
      return;
    }
    // rename：聚焦 + 全选，用户直接敲字就是新名字（省一次三击选中）
    const input = nameInputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [requestedAction]);

  // 合并对话框打开且有关键字时才查候选（空关键字不查，避免把 200 个人都列出来）
  useEffect(() => {
    if (dialog !== "merge" || keyword.trim() === "") {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rows = await Promise.resolve(searchPersons(keyword.trim()));
        if (!cancelled) {
          setCandidates(rows.filter((row) => row.person_id !== person.person_id).slice(0, 8));
        }
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dialog, keyword, person.person_id, searchPersons]);

  const dirty = useMemo(
    () => name.trim() !== person.display_name || note.trim() !== person.remark,
    [name, note, person.display_name, person.remark],
  );

  /**
   * 统一包一层：置忙、清错、成功后回调、失败显红。
   * @param action 实际写操作
   * @param afterId 成功后应选中的 id（归档传 null）
   */
  const run = async (
    action: () => Promise<{ graph_refresh?: { scheduled: boolean } } | void>,
    afterId: string | null,
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await action();
      setDialog(null);
      // 后端排了刷新 → 告诉用户"正在刷新图谱"，别让他在图谱看到旧名以为没生效
      setGraphRefreshing(result?.graph_refresh?.scheduled === true);
      setGraphRefreshError(null);
      onChanged(afterId);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 手动重跑挖掘（后端自动刷新失败或用户等不及时的出口）。
   * 失败时显示可读原因，不静默。
   */
  const retryGraphRefresh = (): void => {
    setGraphRefreshError(null);
    setBusy(true);
    void (async () => {
      try {
        await writePort.runMining();
        setGraphRefreshing(false);
      } catch (err) {
        setGraphRefreshing(false);
        setGraphRefreshError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const save = (): void => {
    const patch: { display_name?: string; note?: string } = {};
    if (name.trim() !== person.display_name) {
      if (name.trim() === "") {
        setFailure("显示名不能为空");
        return;
      }
      patch.display_name = name.trim();
    }
    if (note.trim() !== person.remark) patch.note = note.trim();
    if (Object.keys(patch).length === 0) return;
    void run(async () => writePort.updatePerson(person.person_id, patch), person.person_id);
  };

  return (
    <section
      data-testid="person-actions"
      style={{ borderTop: "1px solid #e5e7eb", marginTop: 16, paddingTop: 12 }}
    >
      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>编辑</h3>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "#6b7280", width: 64 }} htmlFor="person-name-input">
          显示名
        </label>
        <input
          id="person-name-input"
          data-testid="person-name-input"
          ref={nameInputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={{ ...INPUT, flex: 1 }}
        />
        <button
          type="button"
          data-testid="person-rename"
          onClick={save}
          disabled={busy || !dirty}
          style={BTN}
        >
          保存改名
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "#6b7280", width: 64 }} htmlFor="person-note-input">
          备注
        </label>
        <input
          id="person-note-input"
          data-testid="person-note-input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          style={{ ...INPUT, flex: 1 }}
        />
        <button type="button" data-testid="person-note-save" onClick={save} disabled={busy} style={BTN}>
          保存备注
        </button>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          data-testid="person-merge"
          onClick={() => setDialog("merge")}
          disabled={busy}
          style={BTN}
        >
          合并到…
        </button>
        <button
          type="button"
          data-testid="person-delete"
          onClick={() => setDialog("delete")}
          disabled={busy}
          style={{ ...BTN, borderColor: "#fca5a5", color: "#b91c1c" }}
        >
          归档此人
        </button>
      </div>

      {failure !== null && (
        <p role="alert" data-testid="person-action-error" style={{ fontSize: 12, color: "#b91c1c", marginTop: 8 }}>
          操作失败：{failure}
        </p>
      )}

      {graphRefreshing && (
        <p
          data-testid="graph-refreshing"
          style={{ fontSize: 12, color: "#92400e", marginTop: 8 }}
        >
          正在刷新图谱…（后台重算快照，通常 5~30 秒；完成后切到图谱即可看到新名字）
        </p>
      )}

      {(graphRefreshing || graphRefreshError !== null) && (
        <div style={{ marginTop: 6 }}>
          <button type="button" data-testid="graph-refresh-retry" onClick={retryGraphRefresh} disabled={busy} style={BTN}>
            手动刷新图谱
          </button>
        </div>
      )}

      {graphRefreshError !== null && (
        <p role="alert" data-testid="graph-refresh-failed" style={{ fontSize: 12, color: "#b91c1c", marginTop: 6 }}>
          图谱刷新失败，可手动重试：{graphRefreshError}
        </p>
      )}

      {dialog === "merge" && (
        <div
          data-testid="person-merge-dialog"
          style={{ marginTop: 12, border: "1px solid #e5e7eb", borderRadius: 6, padding: 10 }}
        >
          <p style={{ fontSize: 12, margin: "0 0 8px", color: "#374151" }}>
            把「{person.display_name}」合并到（搜索选择目标，不可撤销）：
          </p>
          <input
            data-testid="person-merge-search"
            placeholder="输入名字搜索…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ ...INPUT, width: "100%", marginBottom: 8 }}
          />
          <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>
            {candidates.map((row) => (
              <li key={row.person_id} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  data-testid={`person-merge-candidate-${row.person_id}`}
                  onClick={() => setTarget(row)}
                  aria-pressed={target?.person_id === row.person_id}
                  style={{
                    ...BTN,
                    width: "100%",
                    textAlign: "left",
                    borderColor: target?.person_id === row.person_id ? "#2563eb" : "#d1d5db",
                    background: target?.person_id === row.person_id ? "#eff6ff" : "#fff",
                  }}
                >
                  {row.display_name}
                  <span style={{ color: "#6b7280", marginLeft: 6 }}>{row.msg_count} 条消息</span>
                </button>
              </li>
            ))}
            {keyword.trim() !== "" && candidates.length === 0 && (
              <li style={{ fontSize: 12, color: "#6b7280" }}>没有匹配的人物。</li>
            )}
          </ul>
          {target !== null && (
            <p data-testid="person-merge-consequence" style={{ fontSize: 12, color: "#b91c1c", margin: "0 0 8px" }}>
              合并后「{person.display_name}」的 {person.msg_count} 条消息将归到「{target.display_name}」，
              此人会被标记为已合并，不可撤销。
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="person-merge-confirm"
              disabled={target === null || busy}
              onClick={() => {
                if (target === null) return;
                const targetId = target.person_id;
                void run(
                  async () => writePort.mergePerson(person.person_id, targetId, "manual-merge"),
                  targetId,
                );
              }}
              style={BTN}
            >
              确认合并
            </button>
            <button type="button" onClick={() => setDialog(null)} style={BTN}>
              取消
            </button>
          </div>
        </div>
      )}

      {dialog === "delete" && (
        <div
          data-testid="person-delete-dialog"
          style={{ marginTop: 12, border: "1px solid #fca5a5", borderRadius: 6, padding: 10 }}
        >
          <p style={{ fontSize: 12, color: "#b91c1c", margin: "0 0 8px" }}>
          归档「{person.display_name}」？该人物将不再出现在默认列表与图谱分析中，
          <strong>历史消息不会被删除</strong>（本系统没有物理删除）。
        </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="person-delete-confirm"
              disabled={busy}
              onClick={() => {
                void run(async () => writePort.archivePerson(person.person_id), null);
              }}
              style={{ ...BTN, borderColor: "#fca5a5", color: "#b91c1c" }}
            >
              确认归档
            </button>
            <button type="button" onClick={() => setDialog(null)} style={BTN}>
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
