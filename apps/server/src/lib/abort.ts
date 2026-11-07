/**
 * abort.ts — 按 conversation_id 注册 AbortController
 *
 * POST /api/chat/abort 与客户端断链均调用 abortRegistry.abort()。
 * 同 conversation 重复 register 自动 abort 上一次。
 */

import type { ConversationId } from "@knowself/contracts";

export interface AbortRegistry {
  register(conversationId: ConversationId): AbortSignal;
  abort(conversationId: ConversationId): boolean;
}

export function createAbortRegistry(): AbortRegistry {
  const store = new Map<string, AbortController>();

  return {
    register(conversationId: string): AbortSignal {
      // 同 conversation 重复 register → abort 上一次
      const prev = store.get(conversationId);
      if (prev) {
        prev.abort();
      }
      const ctrl = new AbortController();
      store.set(conversationId, ctrl);
      return ctrl.signal;
    },

    abort(conversationId: string): boolean {
      const ctrl = store.get(conversationId);
      if (!ctrl) return false;
      ctrl.abort();
      store.delete(conversationId);
      return true;
    },
  };
}
