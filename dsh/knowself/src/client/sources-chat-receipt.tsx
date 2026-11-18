/**
 * W-9：聊天导入后的**三选回执**（从 `sources-add-form.tsx` 抽出，纯展示）。
 *
 * 抽出的原因：`sources-add-form.tsx` 已 265 行，回执块占 ~45 行；而不许改行为的重构
 * 只能"搬"——把"长什么样"搬走，状态与请求仍留在表单里（谁拥有数据谁持有状态）。
 *
 * 三态文案是主理人逐字定的，改动前先确认：
 *   - `auto_commit=false` → 「已导入 N 条，等待确认」+【全部采纳本批】+【去待整理】
 *   - 采纳完成           → 「已采纳 N 条，正在生成关系图…」
 *   - `auto_commit=true` → 「已导入并自动采纳 N 条」
 */
import type { CSSProperties, ReactElement } from "react";
import type { AcceptBatchResult, ChatImportResult } from "./chat-import-port.js";
import { PANEL_COLORS, WRAP_TEXT } from "./panel-states.js";

/** 回执 props。 */
export interface SourcesChatReceiptProps {
  /** 导入回包（三选全靠它）。 */
  receipt: ChatImportResult;
  /** 批量采纳结果（null = 还没采纳过）。 */
  acceptResult: AcceptBatchResult | null;
  /** 采纳请求进行中。 */
  accepting: boolean;
  /** 点【全部采纳本批】。 */
  onAcceptBatch: () => void;
  /** 点【完成】。 */
  onDone: () => void;
  /** 点【去待整理】（未传则不显示该按钮）。 */
  onGoInbox?: (() => void) | undefined;
}

const BTN: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 4,
  border: `1px solid ${PANEL_COLORS.border}`,
  background: PANEL_COLORS.surface,
  color: PANEL_COLORS.text,
};

/**
 * 渲染回执块。
 * @param props 见 {@link SourcesChatReceiptProps}
 * @returns 回执元素
 */
export function SourcesChatReceipt({
  receipt,
  acceptResult,
  accepting,
  onAcceptBatch,
  onDone,
  onGoInbox,
}: SourcesChatReceiptProps): ReactElement {
  const noNew =
    receipt.proposals_created === 0 &&
    receipt.messages.committed === 0 &&
    receipt.auto_committed === 0;
  const newest = receipt.wechat?.summary?.newest_message_at;
  return (
    <div data-testid="sources-chat-receipt" style={{ fontSize: 13, ...WRAP_TEXT }}>
      <p style={{ margin: "0 0 6px" }}>
        {noNew
          ? `没有新增消息（已是最新${newest === undefined ? "" : `，微信数据最新到 ${newest.slice(0, 10)}`}）`
          : receipt.auto_committed > 0
            ? `已导入并自动采纳 ${receipt.auto_committed} 条（解析 ${receipt.conversations} 个会话）`
            : `已导入 ${receipt.messages.parsed} 条，等待确认`}
      </p>
      {newest !== undefined && !noNew && (
        <p data-testid="sources-chat-newest" style={{ margin: "0 0 6px", color: PANEL_COLORS.muted }}>
          微信数据最新到 {newest.slice(0, 10)}
        </p>
      )}
      {/* 归属失败如实说：这 N 条不会进入关系分析（不是"导进来了但图里没有"的黑箱） */}
      {receipt.messages.unattributed > 0 && (
        <p data-testid="sources-chat-unattributed" style={{ margin: "0 0 6px", color: PANEL_COLORS.warnText }}>
          其中 {receipt.messages.unattributed} 条无法识别发送者，未参与关系分析
        </p>
      )}
      {receipt.mining_warning !== undefined && (
        <p style={{ margin: "0 0 6px", color: PANEL_COLORS.warnText }}>挖掘告警：{receipt.mining_warning}</p>
      )}
      {acceptResult !== null && (
        <p
          data-testid="sources-chat-accept-result"
          style={{
            margin: "0 0 6px",
            color: acceptResult.failed > 0 ? PANEL_COLORS.warnText : PANEL_COLORS.text,
          }}
        >
          已采纳 {acceptResult.accepted} 条，正在生成关系图…
          {acceptResult.failed > 0 &&
            `（失败 ${acceptResult.failed} 条：${acceptResult.failed_ids.slice(0, 3).join("、")}${acceptResult.failed_ids.length > 3 ? "…" : ""}）`}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {receipt.auto_committed === 0 && acceptResult === null && !noNew && (
          <button
            type="button"
            data-testid="sources-chat-accept-batch"
            disabled={accepting}
            onClick={onAcceptBatch}
            style={{
              ...BTN,
              border: `1px solid ${PANEL_COLORS.accent}`,
              background: PANEL_COLORS.accentBg,
              color: PANEL_COLORS.accentText,
            }}
          >
            {accepting ? "采纳中…" : "全部采纳本批"}
          </button>
        )}
        {onGoInbox !== undefined && (
          <button type="button" data-testid="sources-chat-go-inbox" onClick={onGoInbox} style={BTN}>
            去待整理
          </button>
        )}
        <button type="button" data-testid="sources-chat-close" onClick={onDone} style={BTN}>
          完成
        </button>
      </div>
    </div>
  );
}
