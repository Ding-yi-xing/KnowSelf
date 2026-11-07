import type { ChatHistoryMessage } from "@knowself/contracts";
import type { Ingestion } from "@knowself/ingestion";

export interface WritebackDeps {
  ingestion: Ingestion;
}

export function scheduleWriteback(
  deps: WritebackDeps,
  conversationId: string,
  messages: ChatHistoryMessage[],
): void {
  setImmediate(() => {
    try {
      deps.ingestion.scheduleAutoDistill(conversationId, messages);
    } catch (err) {
      console.error("[writeback] auto distill failed:", err);
    }
  });
}
