// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { KnowselfServices } from "../src/services.js";
import { createSessionDistillAdapter } from "../src/session-distill-adapter.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

function session(id = SESSION_ID): Session {
  return { id } as unknown as Session;
}

function event(value: unknown): SessionEvent {
  return value as SessionEvent;
}

function turnStart(turn: number): SessionEvent {
  return event({ type: "turn/start", seq: 0, time: 1, data: { turn } });
}

function user(text: string): SessionEvent {
  return event({
    type: "user/message",
    seq: 1,
    time: 2,
    data: {
      role: "user",
      id: "user-message",
      source: { kind: "user" },
      content: [{ type: "text", text }],
    },
  });
}

function injected(text: string): SessionEvent {
  return event({
    type: "user/message",
    seq: 1,
    time: 2,
    data: {
      role: "user",
      id: "injected-message",
      source: { kind: "developer" },
      content: [{ type: "text", text }],
    },
  });
}

function assistant(text: string, turn = 1, interrupted = false): SessionEvent {
  return event({
    type: "assistant/message",
    seq: 2,
    time: 3,
    data: {
      turn,
      step: 0,
      message: {
        role: "assistant",
        id: "assistant-message",
        source: { kind: "model", provider: "test", model: "test" },
        content: [{ type: "text", text }],
      },
      stream: [],
      ...(interrupted ? { interrupted: true } : {}),
    },
  });
}

function turnEnd(turn: number, kind: string): SessionEvent {
  return event({
    type: "turn/end",
    seq: 3,
    time: 4,
    data: { turn, reason: kind === "completed" ? { kind: "completed" } : { kind: "aborted", reason: { kind: "user" } } },
  });
}

function makeServices(overrides: {
  ingestion?: KnowselfServices["ingestion"];
  sourceIntake?: KnowselfServices["sourceIntake"];
} = {}) {
  const insertMany = vi.fn();
  const createPasteSource = vi.fn(async () => ({
    id: SOURCE_ID,
  }));
  const services = {
    sourceIntake: overrides.sourceIntake ?? { createPasteSource },
    profileStore: { proposals: { insertMany } },
    ...(overrides.ingestion !== undefined ? { ingestion: overrides.ingestion } : {}),
  } as unknown as KnowselfServices;
  return { services, insertMany, createPasteSource };
}

function complete(adapter: ReturnType<typeof createSessionDistillAdapter>, s: Session, text: string) {
  adapter.onEvent(s, turnStart(1));
  adapter.onEvent(s, user(text));
  adapter.onEvent(s, assistant("我理解了，并给出了一些上下文。"));
  adapter.onEvent(s, turnEnd(1, "completed"));
}

describe("dsh session distill adapter", () => {
  it("仅在 completed flush 时创建低置信审核提案，并对重复 flush 幂等", async () => {
    const { services, insertMany, createPasteSource } = makeServices();
    const adapter = createSessionDistillAdapter(services);
    const s = session();

    complete(adapter, s, "我最近在学习新的工作方法，希望以后能更有条理。请帮我分析一下。您好");
    await adapter.onFlush(s);
    await adapter.onFlush(s);

    expect(createPasteSource).toHaveBeenCalledTimes(1);
    expect(createPasteSource.mock.calls[0]?.[0]?.idempotency_key).toBe(`dsh-session:${SESSION_ID}:1`);
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0]?.[0]?.[0]?.target.kind).toBe("source_distill");
  });

  it("显式记忆意图走自动蒸馏；摄入服务缺失时保留 Source 而不抛错", async () => {
    const runDistill = vi.fn(async () => ({ produced_proposal_ids: [] }));
    const { services, createPasteSource } = makeServices({
      ingestion: { runDistill } as unknown as KnowselfServices["ingestion"],
    });
    const adapter = createSessionDistillAdapter(services);
    const s = session();
    complete(adapter, s, "请记住：我喜欢早上工作，今后按这个偏好提醒我。");

    await adapter.onFlush(s);
    expect(createPasteSource).toHaveBeenCalledTimes(1);
    expect(runDistill).toHaveBeenCalledTimes(1);
  });

  it("丢弃注入内容、被中断回合和单边/寒暄回合", async () => {
    const first = makeServices();
    const adapter = createSessionDistillAdapter(first.services);
    const s = session();
    adapter.onEvent(s, turnStart(1));
    adapter.onEvent(s, injected("这是系统注入内容，不是用户输入"));
    adapter.onEvent(s, assistant("助手输出"));
    adapter.onEvent(s, turnEnd(1, "completed"));
    await adapter.onFlush(s);
    expect(first.createPasteSource).not.toHaveBeenCalled();

    const second = makeServices();
    const adapter2 = createSessionDistillAdapter(second.services);
    const s2 = session("33333333-3333-4333-8333-333333333333");
    adapter2.onEvent(s2, turnStart(1));
    adapter2.onEvent(s2, user("请记住这个内容"));
    adapter2.onEvent(s2, assistant("未完成的输出", 1, true));
    adapter2.onEvent(s2, turnEnd(1, "aborted"));
    await adapter2.onFlush(s2);
    expect(second.createPasteSource).not.toHaveBeenCalled();
  });

  it("超过缓存时限会清理，session/disposed 会释放内存", async () => {
    let clock = 0;
    const { services, createPasteSource } = makeServices();
    const adapter = createSessionDistillAdapter(services, { now: () => clock, cacheTtlMs: 10 });
    const s = session();
    adapter.onEvent(s, turnStart(1));
    adapter.onEvent(s, user("这是一段足够长的有价值对话内容"));
    adapter.onEvent(s, assistant("助手给出了详细回答"));
    adapter.onEvent(s, turnEnd(1, "completed"));
    clock = 100;
    await adapter.onFlush(s);
    expect(createPasteSource).not.toHaveBeenCalled();

    complete(adapter, s, "另一段有价值的对话内容，用来测试 dispose 清理。");
    adapter.onDisposed(s);
    await adapter.onFlush(s);
    expect(createPasteSource).not.toHaveBeenCalled();
  });
});
