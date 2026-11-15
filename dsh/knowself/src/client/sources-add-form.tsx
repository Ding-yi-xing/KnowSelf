/**
 * 「添加资料」四 tab 表单（W-1 三 tab + W-9「导入聊天记录」）。
 *
 * ## 为什么第 4 个 tab 只有**路径输入**，没有文件选择器
 * chat-import 要的是**目录**，而 `<input type="file">` 选不了目录（`webkitdirectory` 在
 * Electron webview 里不可靠，`showDirectoryPicker` 基本不可用）。宁可不做，也不放一个
 * 点了没反应的「浏览…」按钮——那比没有更糟。
 *
 * ## 三选回执（W-9 主理人裁定）
 *   - `auto_commit=false` → 「已导入 N 条，等待确认」+【全部采纳本批】+【去待整理】
 *   - 采纳完成           → 「已采纳 N 条，正在生成关系图…」→ 触发 onMiningRefresh
 *   - `auto_commit=true` → 「已导入并自动采纳 N 条」
 *
 * 边界：只用 React 与浏览器 Web API；文件仅放行 .txt/.md/.json（mime 按扩展名推断），
 * 领域白名单映射由服务端完成；不负责重新蒸馏与列表刷新。
 */
import { useState } from "react";
import type { CSSProperties, FormEvent, ReactElement } from "react";
import type { CreateSourceInput } from "@knowself/contracts";
import type { KnowselfProfilePort } from "./profile-port.js";
import { CHAT_IMPORT_PLATFORMS, createChatImportPort, validateLocalPath } from "./chat-import-port.js";
import { SourcesChatReceipt } from "./sources-chat-receipt.js";
import type { AcceptBatchResult, ChatImportPlatform, ChatImportPort, ChatImportResult } from "./chat-import-port.js";
import { PANEL_COLORS, WRAP_TEXT } from "./panel-states.js";

export interface SourcesAddFormProps {
  port: KnowselfProfilePort;
  onDone: () => void;
  onCancel: () => void;
  /** 聊天导入端口（缺省走同 origin REST）。 */
  chatImport?: ChatImportPort;
  /** 采纳/导入后请求刷新挖掘状态与图谱（显式回调，不靠切面板的隐式时序）。 */
  onMiningRefresh?: () => void;
  /** 「去待整理」跳转（缺省不显示该按钮）。 */
  onGoInbox?: () => void;
}

type Tab = "paste" | "url" | "file" | "chat";
const FILES = [{ ext: ".txt", mime: "text/plain" }, { ext: ".md", mime: "text/markdown" }, { ext: ".json", mime: "application/json" }] as const;
const mimeOf = (name: string): string | undefined => FILES.find((f) => name.toLowerCase().endsWith(f.ext))?.mime;

/** 读文件为纯 base64（去掉 `data:` 前缀）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result ?? "").split(",")[1];
      if (!base64) reject(new Error("文件读取结果为空，请重试")); else resolve(base64);
    };
    reader.onerror = () => reject(new Error("文件读取失败，请重试"));
    reader.readAsDataURL(file);
  });
}

const S: Record<string, CSSProperties> = {
  form: { border: `1px solid ${PANEL_COLORS.border}`, borderRadius: 6, background: PANEL_COLORS.subtleBg, padding: 10, marginBottom: 12 },
  input: { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "6px 8px", border: `1px solid ${PANEL_COLORS.border}`, borderRadius: 4, color: PANEL_COLORS.text, background: PANEL_COLORS.surface },
  label: { display: "block", fontSize: 12, marginBottom: 8 },
  btn: { cursor: "pointer", fontSize: 12, padding: "4px 10px", borderRadius: 4, border: `1px solid ${PANEL_COLORS.border}`, background: PANEL_COLORS.surface, color: PANEL_COLORS.text },
};
const TABS: ReadonlyArray<{ key: Tab; label: string; testId: string }> = [
  { key: "paste", label: "粘贴文本", testId: "sources-tab-paste" },
  { key: "url", label: "网址", testId: "sources-tab-url" },
  { key: "file", label: "文件", testId: "sources-tab-file" },
  { key: "chat", label: "导入聊天记录", testId: "sources-tab-chat" },
];
const tabStyle = (active: boolean): CSSProperties => ({ ...S.btn, border: `1px solid ${active ? PANEL_COLORS.accent : PANEL_COLORS.border}`, background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface, color: active ? PANEL_COLORS.accentText : PANEL_COLORS.text });

const PLATFORM_LABELS: Readonly<
  Record<ChatImportPlatform, { label: string; available: boolean }>
> = {
  wechat: { label: "微信", available: true },
  qq: { label: "QQ", available: false },
  douyin: { label: "抖音", available: false },
};

/**
 * 平台 pill 的数据表：**键来自 `CHAT_IMPORT_PLATFORMS`**（值域单一来源），文案来自上面的
 * 穷举 `Record`。两处配合的效果：`CHAT_IMPORT_PLATFORMS` 加了平台却没配文案 → 编译失败；
 * 契约改了镜像忘了改 → `w9-chat-import-form.test.ts` 的防漂移断言红。
 *
 * `available=false` 表示解析器尚未实现 —— 这类 pill **必须 aria-disabled 且可点**：
 * 点了会选中并让提交按钮置灰、不发请求，用户能看懂"为什么点了不能提交"。原生 `disabled`
 * 的按钮点下去连事件都不触发，属于本清单反复禁止的"点了没反应的死按钮"；更危险的是
 * 用户会以为自己在导 QQ、实际提交的是微信（见 W-34-T02 裁决）。
 */
const PLATFORMS: ReadonlyArray<{ key: ChatImportPlatform; label: string; available: boolean }> =
  CHAT_IMPORT_PLATFORMS.map((key) => ({ key, ...PLATFORM_LABELS[key] }));

/** 平台 pill 的三种态样式（选中 / 可选未选中 / 未开放）。 */
const platformStyle = (active: boolean, available: boolean): CSSProperties => ({
  ...S.btn,
  border: `1px solid ${active ? PANEL_COLORS.accent : PANEL_COLORS.border}`,
  background: active ? PANEL_COLORS.accentBg : PANEL_COLORS.surface,
  color: active ? PANEL_COLORS.accentText : available ? PANEL_COLORS.text : PANEL_COLORS.muted,
});
function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return <label style={S.label}>{label}{children}</label>;
}

/** 四 tab 表单：提交期间禁用全部输入与按钮，失败信息保持可见。 */
export function SourcesAddForm({
  port,
  onDone,
  onCancel,
  chatImport,
  onMiningRefresh,
  onGoInbox,
}: SourcesAddFormProps): ReactElement {
  const [tab, setTab] = useState<Tab>("paste");
  const [title, setTitle] = useState<string>(""); const [text, setText] = useState<string>("");
  const [url, setUrl] = useState<string>(""); const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false); const [error, setError] = useState<string | null>(null);
  /** W-9：聊天导入 */
  const [chatPath, setChatPath] = useState<string>("");
  /** W-34-T02：导入平台（默认微信；QQ/抖音解析器未实现，选中后不允许提交）。 */
  const [platform, setPlatform] = useState<ChatImportPlatform>("wechat");
  const [autoCommit, setAutoCommit] = useState<boolean>(false);
  const [autoCommitReason, setAutoCommitReason] = useState<string>("");
  const [receipt, setReceipt] = useState<ChatImportResult | null>(null);
  const [accepting, setAccepting] = useState<boolean>(false);
  const [acceptResult, setAcceptResult] = useState<AcceptBatchResult | null>(null);

  /** 构造线上 DTO；校验失败抛带中文文案的 Error，由统一 catch 收敛。 */
  const buildInput = async (): Promise<CreateSourceInput> => {
    const trimmed = title.trim();
    if (tab === "paste") {
      const value = text.trim();
      if (value === "") throw new Error("请输入要粘贴的文本");
      return { kind: "paste", ...(trimmed !== "" ? { title: trimmed } : {}), text: value };
    }
    if (tab === "url") {
      const value = url.trim();
      if (value === "") throw new Error("请输入网址");
      return { kind: "url", ...(trimmed !== "" ? { title: trimmed } : {}), url: value };
    }
    if (file === null) throw new Error("请选择文件");
    const mime = mimeOf(file.name);
    if (mime === undefined) throw new Error("仅支持 .txt / .md / .json 文件");
    return { kind: "file", title: file.name, mime_type: mime, content_base64: await readAsBase64(file) };
  };

  /** 聊天导入：路径校验 → 调端点 → 展示三选回执（不立刻 onDone，否则回执消失）。 */
  const submitChatImport = async (): Promise<void> => {
    // 平台闸（前端第二道）：QQ/抖音的解析器未实现，**一个请求都不发**。
    // 服务端同样有闸（400 PLATFORM_NOT_SUPPORTED），这里提前拦是为了不让用户白等一次往返。
    // 保留 throw 而不是静默 return：表单按 Enter 提交时会绕过 disabled 的提交按钮，
    // 那时必须给用户一句可读的话，而不是"点了没反应"。
    if (platform !== "wechat") {
      throw new Error(`${platform === "qq" ? "QQ" : "抖音"} 的导入暂未开放`);
    }
    const invalid = validateLocalPath(chatPath);
    if (invalid !== null) throw new Error(invalid);
    if (autoCommit && autoCommitReason.trim() === "") {
      throw new Error("勾选「自动采纳」时必须填写理由（会写进审计日志）");
    }
    const client = chatImport ?? createChatImportPort();
    const result = await client.importChat({
      source_path: chatPath.trim(),
      platform,
      ...(autoCommit
        ? { auto_commit: true, auto_commit_reason: autoCommitReason.trim() }
        : {}),
    });
    setReceipt(result);
    setAcceptResult(null);
    if (result.auto_committed > 0) onMiningRefresh?.();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null); setSubmitting(true);
    try {
      if (tab === "chat") await submitChatImport();
      else { await port.createSource(await buildInput()); onDone(); }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSubmitting(false); }
  };

  /** 全部采纳本批：用**回包里的 source_id**，不自己拼 batch_id。 */
  const onAcceptBatch = async (): Promise<void> => {
    if (receipt === null || accepting) return;
    setAccepting(true); setError(null);
    try {
      const client = chatImport ?? createChatImportPort();
      const result = await client.acceptBatch(receipt.source_id);
      setAcceptResult(result);
      if (result.accepted > 0) onMiningRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  };

  /** 所有输入共用：提交中禁用 + 统一样式。 */
  const inp = (extra?: CSSProperties): { disabled: boolean; style: CSSProperties } => ({ disabled: submitting, style: { ...S.input, marginTop: 4, ...extra } });

  return (
    <form data-testid="sources-add-form" onSubmit={(event) => void onSubmit(event)} style={S.form}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {TABS.map((item) => (
          <button key={item.key} type="button" data-testid={item.testId} aria-pressed={tab === item.key} disabled={submitting}
            onClick={() => { setTab(item.key); setError(null); setReceipt(null); setAcceptResult(null); }} style={tabStyle(tab === item.key)}>{item.label}</button>
        ))}
      </div>
      {tab !== "file" && tab !== "chat" && (
        <Field label="标题（可选）">
          <input data-testid="sources-add-title" type="text" value={title}
            onChange={(event) => setTitle(event.currentTarget.value)} {...inp()} />
        </Field>
      )}
      {tab === "paste" && (
        <Field label="文本内容（必填）">
          <textarea data-testid="sources-paste-text" rows={5} value={text}
            onChange={(event) => setText(event.currentTarget.value)} {...inp({ ...WRAP_TEXT, resize: "vertical" })} />
        </Field>
      )}
      {tab === "url" && (
        <Field label="网址（必填）">
          <input data-testid="sources-url-input" type="url" value={url}
            onChange={(event) => setUrl(event.currentTarget.value)} {...inp()} />
        </Field>
      )}
      {tab === "file" && (
        <Field label="选择文件（.txt / .md / .json）">
          <input data-testid="sources-file-input" type="file"
            accept=".txt,.md,.json,text/plain,text/markdown,application/json"
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0] ?? null;
              setFile(selected);
              setError(selected !== null && mimeOf(selected.name) === undefined ? "仅支持 .txt / .md / .json 文件" : null);
            }} {...inp()} />
        </Field>
      )}
      {tab === "chat" && receipt === null && (
        <>
          {/* W-34-T02：来源平台三选一。微信可用；QQ/抖音为占位（点得动、能选中、但提交被拦） */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: PANEL_COLORS.text }}>平台</span>
            {PLATFORMS.map((item) => (
              <button
                key={item.key}
                type="button"
                data-testid={`sources-chat-platform-${item.key}`}
                aria-pressed={platform === item.key}
                {...(item.available ? {} : { "aria-disabled": "true" })}
                disabled={submitting}
                onClick={() => {
                  setPlatform(item.key);
                  setError(null);
                }}
                style={platformStyle(platform === item.key, item.available)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "0 0 8px", ...WRAP_TEXT }}>
            QQ / 抖音：暂未开放
          </p>
          <Field label="聊天导出目录（必填）">
            <input data-testid="sources-chat-path" type="text" value={chatPath}
              placeholder="示例：C:\\Users\\你\\Documents\\聊天导出"
              onChange={(event) => { setChatPath(event.currentTarget.value); setError(validateLocalPath(event.currentTarget.value)); }}
              {...inp()} />
          </Field>
          <p style={{ fontSize: 12, color: PANEL_COLORS.muted, margin: "0 0 8px", ...WRAP_TEXT }}>
            仅支持本地目录（填网址会被拦下）。
          </p>
          <label style={{ ...S.label, display: "flex", alignItems: "center", gap: 6 }}>
            <input data-testid="sources-chat-auto-commit" type="checkbox" checked={autoCommit}
              disabled={submitting} onChange={(event) => setAutoCommit(event.currentTarget.checked)} />
            导入后自动采纳（会替你做复核决定，需填写理由）
          </label>
          {autoCommit && (
            <Field label="自动采纳理由（必填，进审计日志）">
              <input data-testid="sources-chat-auto-reason" type="text" value={autoCommitReason}
                placeholder="例如：w9-acceptance" onChange={(event) => setAutoCommitReason(event.currentTarget.value)} {...inp()} />
            </Field>
          )}
        </>
      )}
      {tab === "chat" && receipt !== null && (
        <SourcesChatReceipt
          receipt={receipt}
          acceptResult={acceptResult}
          accepting={accepting}
          onAcceptBatch={() => void onAcceptBatch()}
          onDone={onDone}
          {...(onGoInbox === undefined ? {} : { onGoInbox })}
        />
      )}
      {error !== null && (
        <p role="alert" data-testid="sources-add-error"
          style={{ fontSize: 12, color: PANEL_COLORS.dangerText, ...WRAP_TEXT }}>{error}</p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" data-testid="sources-submit"
          disabled={submitting || (tab === "chat" && platform !== "wechat")}
          style={{ ...S.btn, padding: "5px 14px", cursor: submitting ? "default" : "pointer", border: `1px solid ${PANEL_COLORS.accent}`, background: PANEL_COLORS.accentBg, color: PANEL_COLORS.accentText }}>
          {submitting ? "提交中…" : tab === "chat" ? "开始导入" : "提交"}
        </button>
        <button type="button" disabled={submitting} onClick={onCancel} style={{ ...S.btn, padding: "5px 14px" }}>取消</button>
      </div>
    </form>
  );
}
