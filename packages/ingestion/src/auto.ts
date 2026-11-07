/**
 * auto.ts — 对话自动蒸馏调度
 *
 * fire-and-forget 模型：对话完成后触发 distill，不阻塞 chat 响应。
 * 用 queueMicrotask 确保当前事件循环结束后才执行。
 */

import type { ChatHistoryMessage } from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import { runDistill } from "./distill";

/** scheduleAutoDistill 依赖。 */
export interface AutoDeps {
  store: ProfileStore;
  providerAdapter: ProviderAdapter;
  distillProviderId: string;
  /** 把对话消息变成 source 的入口。 */
  createSourceFromMessages: (
    conversationId: string,
    messages: ChatHistoryMessage[],
  ) => Promise<{ sourceId: string }>;
  now?: () => string;
}

/**
 * 在对话完成后调度一次自动蒸馏。
 * 执行是 fire-and-forget 的；调度后立即返回。
 */
export function scheduleAutoDistill(
  deps: AutoDeps,
  conversationId: string,
  messages: ChatHistoryMessage[],
): void {
  queueMicrotask(() => {
    runAutoDistill(deps, conversationId, messages).catch((err) => {
      console.error("[auto-distill] unexpected error:", err instanceof Error ? err.message : String(err));
    });
  });
}

async function runAutoDistill(
  deps: AutoDeps,
  conversationId: string,
  messages: ChatHistoryMessage[],
): Promise<void> {
  // 1. 把对话消息转成 source
  const { sourceId } = await deps.createSourceFromMessages(conversationId, messages);
  if (!sourceId) return;

  // 2. 读回 source 对象
  const source = deps.store.sources.get(sourceId);
  if (!source) return;

  // 3. 执行蒸馏
  const distillDeps = {
    store: deps.store,
    providerAdapter: deps.providerAdapter,
    distillProviderId: deps.distillProviderId,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    await runDistill(distillDeps, source, {
      provider_id: deps.distillProviderId,
      focus_hints: ["对话中用户分享的个人信息"],
      max_proposals: 4,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[auto-distill] distill failed for source", sourceId, ":", msg);
    try {
      deps.store.sources.updateError(sourceId, msg, now());
    } catch { /* swallow repo error */ }
  }
}
