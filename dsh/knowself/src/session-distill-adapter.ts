import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { CreateSourceRequest } from "@knowself/contracts";
import type { KnowselfServices } from "./services.js";

const DEFAULT_MAX_MESSAGES = 32;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const PROVIDER_ID = "dsh-session:rule-v1";

type Logger = {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

type CapturedMessage = {
  role: "user" | "assistant";
  text: string;
};

type TurnCapture = {
  key: string;
  sessionId: string;
  turn: number;
  startedAt: number;
  lastSeenAt: number;
  messages: CapturedMessage[];
  chars: number;
  completed: boolean;
  overflowed: boolean;
  persisted: boolean;
  processing?: Promise<void>;
};

export interface SessionDistillAdapterOptions {
  now?: () => number;
  maxMessages?: number;
  maxChars?: number;
  cacheTtlMs?: number;
  logger?: Logger;
}

export interface SessionDistillAdapter {
  onEvent(session: Session, event: SessionEvent): void;
  onFlush(session: Session): Promise<void>;
  onDisposed(session: Session): void;
  dispose(): void;
}

function textBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function sessionIdOf(session: Session): string {
  return String(session.id);
}

function captureKey(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`;
}

function isDirectUserMessage(message: UserMessage): boolean {
  return message.source.kind === "user";
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function isLowValue(text: string): boolean {
  const normalized = text.replace(/[\s，。！？,.!?]/g, "").toLowerCase();
  if (normalized.length < 4) return true;
  return /^(你好|嗨|hi|hello|谢谢|好的|嗯|哦|收到|再见|拜拜)+$/.test(normalized);
}

function renderConversation(messages: readonly CapturedMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`)
    .join("\n\n");
}

function sourceRequest(
  sessionId: string,
  turn: number,
  text: string,
): Extract<CreateSourceRequest, { kind: "paste" }> {
  return {
    kind: "paste",
    idempotency_key: `dsh-session:${sessionId}:${turn}`,
    text,
    original_name: `dsh 对话 ${sessionId.slice(0, 12)}-${turn}`,
    user_note: "由 dsh 会话适配器捕获；仅在完成回合的 flush 检查点写入。",
    user_tags: ["dsh-session"],
  };
}

export function createSessionDistillAdapter(
  services: KnowselfServices,
  options: SessionDistillAdapterOptions = {},
): SessionDistillAdapter {
  const now = options.now ?? Date.now;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const logger = options.logger;
  const captures = new Map<string, TurnCapture>();
  const drains = new Map<string, Promise<void>>();
  let disposed = false;

  function getOrCreate(session: Session, turn: number): TurnCapture {
    const sessionId = sessionIdOf(session);
    const key = captureKey(sessionId, turn);
    const existing = captures.get(key);
    if (existing) return existing;
    const capture: TurnCapture = {
      key,
      sessionId,
      turn,
      startedAt: now(),
      lastSeenAt: now(),
      messages: [],
      chars: 0,
      completed: false,
      overflowed: false,
      persisted: false,
    };
    captures.set(key, capture);
    return capture;
  }

  function append(capture: TurnCapture, role: CapturedMessage["role"], rawText: string): void {
    if (capture.persisted || capture.overflowed) return;
    const text = normalize(rawText);
    if (!text) return;
    capture.lastSeenAt = now();
    if (capture.messages.length >= maxMessages || capture.chars + text.length > maxChars) {
      capture.overflowed = true;
      return;
    }
    capture.messages.push({ role, text });
    capture.chars += text.length;
  }

  function eventTurn(session: Session): number | undefined {
    // user/message intentionally has no turn field in dsh-session. The live
    // turn/start marker is the only supported association; do not inspect the
    // session history to reconstruct one.
    return activeTurns.get(sessionIdOf(session));
  }

  const activeTurns = new Map<string, number>();

  function handleEvent(session: Session, event: SessionEvent): void {
    if (disposed) return;
    const sessionId = sessionIdOf(session);
    if (event.type === "turn/start") {
      activeTurns.set(sessionId, event.data.turn);
      getOrCreate(session, event.data.turn);
      return;
    }
    if (event.type === "turn/end") {
      const capture = captures.get(captureKey(sessionId, event.data.turn));
      activeTurns.delete(sessionId);
      if (capture) {
        capture.lastSeenAt = now();
        capture.completed = event.data.reason.kind === "completed";
        if (!capture.completed) captures.delete(capture.key);
      }
      return;
    }
    if (event.type === "user/message") {
      if (!isDirectUserMessage(event.data)) return;
      const turn = eventTurn(session);
      if (turn === undefined) return;
      append(getOrCreate(session, turn), "user", textBlocks(event.data.content));
      return;
    }
    if (event.type === "assistant/message") {
      if (event.data.interrupted === true) return;
      append(getOrCreate(session, event.data.turn), "assistant", textBlocks(event.data.message.content));
    }
  }

  async function persist(capture: TurnCapture): Promise<void> {
    if (capture.persisted || !capture.completed || capture.overflowed) return;
    if (capture.messages.length < 2) return;
    const userText = capture.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)
      .join("\n");
    if (!userText || isLowValue(userText)) return;
    const conversation = renderConversation(capture.messages);
    const source = await services.sourceIntake.createPasteSource(
      sourceRequest(capture.sessionId, capture.turn, conversation),
    );

    if (!services.ingestion) {
      logger?.warn?.("dsh 会话价值判断降级：摄入服务不可用，已保留 Source 但不生成待整理", {
        sourceId: source.id,
        sessionId: capture.sessionId,
        turn: capture.turn,
      });
      capture.persisted = true;
      return;
    }

    try {
      // 由蒸馏模型判断这段对话是否有写入画像的价值：
      // 返回 0 条 write = 无价值，不产生待整理；返回 write = 有价值，直接采纳。
      const result = await services.ingestion.runDistill(source, {
        provider_id: "",
        focus_hints: [
          "只提取用户明确表达且未来仍适用的个人信息、偏好、决定、长期目标或重要关系",
          "忽略一次性的操作指令、代码调试过程、界面修改过程和寒暄",
        ],
        max_proposals: 4,
        force: false,
      });
      for (const proposalId of result.produced_proposal_ids) {
        try {
          services.ingestion.acceptProposal(proposalId);
        } catch (error) {
          logger?.warn?.("dsh 会话有价值提案自动采纳失败，保留为待整理", {
            proposalId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger?.warn?.("dsh 会话价值判断/蒸馏失败，Source 保留但不进待整理", {
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    capture.persisted = true;
  }

  async function drainReady(session: Session): Promise<void> {
    const sessionId = sessionIdOf(session);
    const current = now();
    for (const capture of captures.values()) {
      if (capture.sessionId !== sessionId) continue;
      if (current - capture.lastSeenAt > cacheTtlMs) {
        captures.delete(capture.key);
        continue;
      }
      if (!capture.completed || capture.persisted || capture.processing) continue;
      capture.processing = persist(capture)
        .catch((error: unknown) => {
          logger?.error?.("dsh 会话 flush 蒸馏失败；保留内存捕获以便后续重试", error);
        })
        .finally(() => {
          delete capture.processing;
        });
      await capture.processing;
    }
    for (const [key, capture] of captures) {
      if (capture.sessionId === sessionId && capture.persisted) captures.delete(key);
    }
  }

  return {
    onEvent: handleEvent,
    onFlush(session) {
      if (disposed) return Promise.resolve();
      const sessionId = sessionIdOf(session);
      const existing = drains.get(sessionId);
      if (existing) return existing;
      const drain = drainReady(session).finally(() => {
        if (drains.get(sessionId) === drain) {
          drains.delete(sessionId);
        }
      });
      drains.set(sessionId, drain);
      return drain.catch((error: unknown) => {
        logger?.error?.("dsh 会话 flush 适配器异常已隔离", error);
      });
    },
    onDisposed(session) {
      const sessionId = sessionIdOf(session);
      activeTurns.delete(sessionId);
      for (const [key, capture] of captures) {
        if (capture.sessionId === sessionId) captures.delete(key);
      }
    },
    dispose() {
      disposed = true;
      activeTurns.clear();
      captures.clear();
      drains.clear();
    },
  };
}

export function registerSessionDistillAdapter(
  ctx: Context,
  services: KnowselfServices,
  options: SessionDistillAdapterOptions = {},
): () => void {
  const adapter = createSessionDistillAdapter(services, {
    ...options,
    logger: options.logger ?? ctx.logger("knowself"),
  });
  // Some lightweight registration harnesses intentionally omit the dsh event
  // service. Keep those core/plugin tests valid while the real dsh Context
  // still receives all three listeners below.
  if (typeof ctx.on !== "function") {
    return () => adapter.dispose();
  }
  const eventDispose = ctx.on("session/event", (session, event) => {
    adapter.onEvent(session, event);
  });
  const flushDispose = ctx.on("session/flush", async (session) => {
    await adapter.onFlush(session);
  });
  const disposedDispose = ctx.on("session/disposed", (session) => {
    adapter.onDisposed(session);
  });
  return () => {
    eventDispose();
    flushDispose();
    disposedDispose();
    adapter.dispose();
  };
}
