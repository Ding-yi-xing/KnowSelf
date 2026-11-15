/**
 * 「聊天数据源」卡片（W-35-B）——把「更新聊天记录」从「添加资料 → chat tab」里提出来。
 *
 * ## 为什么单独一张常驻卡片，而不是留在表单里
 * 用户的心智是「把我的聊天同步到最新」，不是「新建一份资料」。而聊天导入本身是**幂等**的
 * （同一目录重跑只会 `ignored`），所以「更新」= 再跑一次，既不需要挑新增、也不需要模型。
 * 藏进「添加资料」的多 tab 表单里，等于逼用户先理解"资料"这个抽象才能完成一件日常动作。
 *
 * ## 目录为什么是手填文本框而不是系统目录选择器
 * Electron 里调系统目录对话框要走 IPC（渲染进程拿不到 `showDirectoryPicker`），
 * 成本远大于收益。可编辑文本框 + localStorage 记住上次填的值，已经够用。
 *
 * ## 350 秒的导入必须有"已用秒数"
 * 全量导入实测约 350 秒。没有反馈的话用户会以为卡死然后反复点（进而并发导入）。
 * 因此进行中时按钮禁用 + 文案「更新中…」+ 旁边实时显示「已用 N 秒」。
 *
 * 数据来源全部经端口（props 注入，缺省同 origin REST）：`MiningPort.getStatus` 读统计、
 * `ChatImportPort.importChat` 触发导入。面板不直接拼 fetch。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { createChatImportPort } from "./chat-import-port.js";
import type { ChatImportPort, ChatImportResult } from "./chat-import-port.js";
import { createRestMiningPort } from "./mining-port.js";
import type { MiningPort, MiningStatus } from "./mining-port.js";
import {
  COLORS,
  RADIUS,
  SECONDARY_BUTTON,
  SPACE,
  TABULAR,
  TYPE,
  WRAP_TEXT,
} from "./ui-tokens.js";

/** 微信导出产物的默认目录（与 `scripts/wechat/export-all.mjs` 的输出约定一致）。 */
export const DEFAULT_CHAT_SOURCE_DIR = "C:/dsh-lab/wechat-export/current";

/** localStorage 里记住用户填过的目录（换目录后不用每次重打）。 */
const STORAGE_KEY = "knowself.chatSourceDir";

/** 自动采纳理由（进服务端审计日志；"手动刷新"是一个可回溯的来源标记）。 */
const AUTO_COMMIT_REASON = "manual-refresh";

/** 组件 props。 */
export interface ChatSourceCardProps {
  /** 挖掘状态端口（只用到 `getStatus`）。缺省走同 origin REST。 */
  mining?: Pick<MiningPort, "getStatus">;
  /** 聊天导入端口。缺省走同 origin REST。 */
  chatImport?: ChatImportPort;
  /** localStorage 键（测试可换一个，避免与其他用例互相污染）。 */
  storageKey?: string;
}

/**
 * 千分位格式化（手写，不用 `toLocaleString`）。
 *
 * 为什么手写：`toLocaleString()` 依赖运行环境 locale，jsdom / CI / 用户机器可能给出
 * `151886` / `151,886` / `151.886` 三种结果，断言会随环境漂。这里固定 `,` 分组。
 *
 * @param value 计数
 * @returns 形如 `151,886`
 */
function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 读上次填过的目录；localStorage 不可用（SSR / 隐私模式）时退回默认值，不抛。
 * @param key localStorage 键
 */
function readStoredDir(key: string): string {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_CHAT_SOURCE_DIR;
    const stored = localStorage.getItem(key);
    return stored === null || stored === "" ? DEFAULT_CHAT_SOURCE_DIR : stored;
  } catch {
    return DEFAULT_CHAT_SOURCE_DIR;
  }
}

/** 卡片外框。 */
const CARD: CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: RADIUS.card,
  background: COLORS.surface,
  padding: SPACE.md,
};

/** 字段标签（"目录"/"消息"这种单字标签，不是整句说明）。 */
const LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: COLORS.subtle,
  minWidth: 40,
  flexShrink: 0,
};

/** 一行「标签 + 值」。 */
function Row({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}

/**
 * 聊天数据源卡片。
 *
 * 加载流程：挂载时读一次 `/mining/status` 渲染统计；点「立即更新」→ 调幂等导入 →
 * 成功后重读统计并展示本次结果（解析 / 新写入 / 忽略 / 耗时）。
 */
export function ChatSourceCard({
  mining,
  chatImport,
  storageKey = STORAGE_KEY,
}: ChatSourceCardProps): ReactElement {
  const miningApi = useMemo(() => mining ?? createRestMiningPort(), [mining]);
  const chatApi = useMemo(() => chatImport ?? createChatImportPort(), [chatImport]);

  const [dir, setDir] = useState<string>(() => readStoredDir(storageKey));
  const [status, setStatus] = useState<MiningStatus | null>(null);
  /** 统计读取失败（**不覆盖导入错误**：两者是不同的事）。 */
  const [statusError, setStatusError] = useState<string | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  /** 本次导入的开始时刻（null = 未在跑）；用于算「已用 N 秒」。 */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  /** 上一次导入的结果（成功后展示）。 */
  const [result, setResult] = useState<ChatImportResult | null>(null);
  /** 上一次导入的耗时（秒）。 */
  const [resultSec, setResultSec] = useState<number>(0);
  /** 导入失败原文（不加工、不吞掉）。 */
  const [error, setError] = useState<string | null>(null);

  /** 读一次统计。失败只记在 `statusError`，不影响导入。 */
  const reloadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await miningApi.getStatus();
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, [miningApi]);

  // 挂载时读统计一次
  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  // 记住目录（换目录后不用重打）
  useEffect(() => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, dir);
    } catch {
      /* 隐私模式下 setItem 会抛，忽略：只是"记不住"，不影响导入 */
    }
  }, [dir, storageKey]);

  // 进行中每秒刷新「已用 N 秒」——350 秒的导入没有秒数会让人以为卡死
  useEffect(() => {
    if (startedAt === null) return;
    const tick = (): void => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);

  const trimmedDir = dir.trim();
  const canRefresh = trimmedDir !== "" && !running;

  /** 立即更新：幂等导入 → 刷新统计 → 展示结果；失败原文可见。 */
  const refresh = async (): Promise<void> => {
    if (!canRefresh) return;
    const begin = Date.now();
    setRunning(true);
    setError(null);
    setResult(null);
    setElapsedSec(0);
    setStartedAt(begin);
    try {
      const imported = await chatApi.importChat({
        source_path: trimmedDir,
        auto_commit: true,
        auto_commit_reason: AUTO_COMMIT_REASON,
      });
      setResult(imported);
      setResultSec(Math.max(0, Math.round((Date.now() - begin) / 1000)));
      await reloadStatus();
    } catch (err) {
      // 原样显示错误：只说「更新失败」的话，用户和我们都无法判断是路径错、权限错还是服务 500
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStartedAt(null);
    }
  };

  return (
    <section data-testid="chat-source-card" style={CARD} aria-label="聊天数据源">
      <h3 style={{ ...TYPE.section, margin: `0 0 ${SPACE.sm}px` }}>聊天数据源</h3>

      <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>
        <Row label="目录">
          <input
            data-testid="chat-source-dir"
            aria-label="聊天导出目录"
            value={dir}
            disabled={running}
            placeholder={DEFAULT_CHAT_SOURCE_DIR}
            onChange={(event) => setDir(event.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              padding: `${SPACE.xs}px ${SPACE.sm}px`,
              border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: RADIUS.control,
              color: COLORS.text,
              background: COLORS.surface,
              fontFamily: "inherit",
            }}
          />
        </Row>

        <Row label="消息">
          <span
            data-testid="chat-source-stats"
            style={{ ...TYPE.meta, ...TABULAR, color: COLORS.text }}
          >
            {status === null
              ? "—"
              : `${formatCount(status.chat_message_count)} 条 · ${formatCount(
                  status.chat_conversation_count,
                )} 会话 · ${formatCount(status.person_count)} 人`}
          </span>
        </Row>

        <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
          <button
            type="button"
            data-testid="chat-source-refresh"
            disabled={!canRefresh}
            onClick={() => void refresh()}
            style={SECONDARY_BUTTON}
          >
            {running ? "更新中…" : "立即更新"}
          </button>
          {running && (
            <span style={{ ...TYPE.meta, ...TABULAR, color: COLORS.subtle }}>
              已用 {elapsedSec} 秒
            </span>
          )}
          {!running && trimmedDir === "" && (
            <span style={{ ...TYPE.meta, color: COLORS.subtle }}>请填入微信导出目录</span>
          )}
        </div>

        {statusError !== null && (
          <p style={{ ...TYPE.meta, color: COLORS.subtle, margin: 0, ...WRAP_TEXT }}>
            统计读取失败：{statusError}
          </p>
        )}

        {result !== null && (
          <p
            data-testid="chat-source-result"
            style={{ ...TYPE.meta, ...TABULAR, color: COLORS.muted, margin: 0, ...WRAP_TEXT }}
          >
            {`上次结果：解析 ${formatCount(result.messages.parsed)} / 新写入 ${formatCount(
              result.messages.committed,
            )} / 忽略 ${formatCount(result.messages.ignored)} · ${resultSec} 秒`}
          </p>
        )}

        {error !== null && (
          <p
            role="alert"
            data-testid="chat-source-error"
            style={{ ...TYPE.meta, color: COLORS.danger, margin: 0, ...WRAP_TEXT }}
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
