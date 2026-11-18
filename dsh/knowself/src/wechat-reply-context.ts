import { createHash } from "node:crypto";
import type { ReplyContextMessage, ReplyHistorySource, ReplyRetrievalIndex } from "@knowself/context-router";
import type { ReplyConversationRow, ReplyHistoryRepo } from "@knowself/person-store";
import { compactReplyContext } from "./reply-quality.js";

const MAX_RECENT = 60;
const MAX_RELEVANT = 12;
const MAX_TOKEN_BUDGET = 6000;

export interface ReplyContextAudit {
  task_id: string;
  contact_id_hash: string;
  conversation_id_hash: string;
  source_message_ids_hash: string;
  source_count: number;
  estimated_chars: number;
  authorization_version: number;
  degraded: string[];
}

export interface WechatReplyContext {
  conversation_id: string;
  recent: ReplyContextMessage[];
  relevant: ReplyContextMessage[];
  estimated_tokens: number;
  degraded: string[];
}

export class ReplyContextError extends Error {
  constructor(
    message: string,
    public readonly code: "HISTORY_NOT_AUTHORIZED" | "CONTACT_CONVERSATION_MISMATCH" | "REPLY_INDEX_UNAVAILABLE",
  ) {
    super(message);
    this.name = "ReplyContextError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function fitMessages(messages: ReplyContextMessage[], tokenBudget: number): ReplyContextMessage[] {
  let remaining = tokenBudget;
  const selected: ReplyContextMessage[] = [];
  for (const message of messages) {
    if (remaining <= 0) break;
    const cost = estimateTokens(message.content);
    if (cost <= remaining) {
      selected.push(message);
      remaining -= cost;
      continue;
    }
    const content = message.content.slice(0, remaining * 3);
    if (content.trim() !== "") selected.push({ ...message, content });
    remaining = 0;
  }
  return selected;
}

export function createWechatReplyContextService(deps: {
  history: ReplyHistoryRepo;
  index: ReplyRetrievalIndex;
  source: ReplyHistorySource;
  audit?: (entry: ReplyContextAudit) => void | Promise<void>;
}) {
  return {
    async build(input: {
      task_id: string;
      contact_id: string;
      conversation_id: string;
      query: string;
      history_authorized: boolean;
      authorization_version: number;
      recent_limit?: number;
      top_k?: number;
      token_budget?: number;
    }): Promise<WechatReplyContext> {
      if (!input.history_authorized) {
        throw new ReplyContextError("History use is not authorized", "HISTORY_NOT_AUTHORIZED");
      }
      const matches = deps.history.listDirectConversations().filter(
        (row: ReplyConversationRow) => row.contact_id === input.contact_id,
      );
      if (matches.length !== 1 || matches[0]?.conversation_id !== input.conversation_id) {
        throw new ReplyContextError("Contact and direct conversation do not match", "CONTACT_CONVERSATION_MISMATCH");
      }
      const contact = matches[0]!;
      const state = deps.index.state(contact.conversation_id);
      if (state?.state !== "ready") {
        throw new ReplyContextError("Reply history index is unavailable", "REPLY_INDEX_UNAVAILABLE");
      }

      // Only refresh an initialized conversation; first-time imports remain on the
      // controlled startup/import indexing path.
      const synced = deps.index.syncConversation({
        conversation_id: contact.conversation_id,
        contact_id: contact.contact_id,
        title: contact.title,
      }, deps.source, { batchSize: 500, maxMessages: 1000 });

      // 「无上下限检索」+ 预算注入：查询覆盖整段会话（index.search 无时间过滤），
      // 但只取最相关的一小撮 + 少量近期连续性，并压缩后再进 prompt。
      const recentLimit = Math.max(1, Math.min(input.recent_limit ?? 8, MAX_RECENT));
      const topK = Math.max(0, Math.min(input.top_k ?? 8, MAX_RELEVANT));
      const tokenBudget = Math.max(128, Math.min(input.token_budget ?? 1500, MAX_TOKEN_BUDGET));
      const degraded: string[] = [];
      if (synced >= 1000) degraded.push("Incremental history refresh reached its per-turn limit");
      const recent = compactReplyContext(
        deps.index.recent(contact.conversation_id, recentLimit)
          .filter((message) => message.conversation_id === contact.conversation_id),
        { maxPerMessage: 60, limit: recentLimit },
      );
      let relevant: ReplyContextMessage[] = [];
      if (topK > 0 && input.query.trim() !== "") {
        try {
          relevant = compactReplyContext(
            deps.index.search(contact.conversation_id, input.query.slice(0, 2000), topK)
              .filter((message) => message.conversation_id === contact.conversation_id),
            { maxPerMessage: 60, limit: topK },
          );
        } catch {
          degraded.push("Keyword search failed; recent messages only");
        }
      }
      const recentIds = new Set(recent.map((message) => message.message_id));
      relevant = relevant.filter((message) => !recentIds.has(message.message_id));

      const recentBudget = Math.min(tokenBudget, Math.ceil(tokenBudget * 0.7));
      const selectedRecent = fitMessages([...recent.slice(-recentLimit)].reverse(), recentBudget).reverse();
      const used = selectedRecent.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      const selectedRelevant = fitMessages(relevant, Math.max(0, tokenBudget - used));
      const all = [...selectedRecent, ...selectedRelevant];
      const estimatedChars = all.reduce((sum, message) => sum + message.content.length, 0);
      const ids = all.map((message) => message.message_id).sort();
      const result: WechatReplyContext = {
        conversation_id: contact.conversation_id,
        recent: selectedRecent,
        relevant: selectedRelevant,
        estimated_tokens: all.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        degraded,
      };
      await deps.audit?.({
        task_id: input.task_id,
        contact_id_hash: digest(input.contact_id),
        conversation_id_hash: digest(input.conversation_id),
        source_message_ids_hash: digest(ids.join("\n")),
        source_count: all.length,
        estimated_chars: estimatedChars,
        authorization_version: input.authorization_version,
        degraded,
      });
      return result;
    },
  };
}
