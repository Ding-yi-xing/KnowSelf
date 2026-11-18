import { describe, expect, it } from "vitest";
import type { ChatChunk, ChatOptions } from "@knowself/contracts";
import { runWechatReplyWorker, type ReplyWorkerDeps } from "../src/wechat-reply-worker.js";
import { withModelRetry } from "../src/model-retry.js";

function baseTask() {
  return {
    id: "task-1", account_scope: "account-1", conversation_id: "conv-a", contact_id: "alice",
    objective: "respond kindly", provider_id: "provider-1", model_id: "model-1", history_authorized: false,
    authorization_version: 1, status: "running" as const, stop_reason: null, lease_owner: "owner-1", lease_until: null,
    turn_count: 0, send_count: 0, created_at: "2026-11-16T10:00:00.000Z", updated_at: new Date().toISOString(), stopped_at: null,
  };
}

function setup(messages: Array<{ message_id: string; conversation_id: string; sender_id: string; body: string; received_at: string }> = [
  { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "hello", received_at: "2026-11-16T10:00:00.000Z" },
]) {
  const controller = new AbortController();
  const turns = new Map<number, Record<string, unknown>>();
  const sent: string[] = [];
  const prompts: string[] = [];
  let nextId = 0;
  const deps: ReplyWorkerDeps = {
    task: baseTask(),
    owner: "owner-1",
    signal: controller.signal,
    store: {
      createTurn: (_owner, record) => {
        if (record.inbound_message_id !== null
          && [...turns.values()].some((turn) => turn.inbound_message_id === record.inbound_message_id)) return 0;
        const id = ++nextId;
        turns.set(id, { ...record });
        return id;
      },
      finishTurn: (_owner, _taskId, id, input) => {
        const turn = turns.get(id);
        if (!turn) return false;
        Object.assign(turn, input);
        return true;
      },
      progress: () => true,
      canContinue: () => true,
    },
    transport: {
      probeCapabilities: async () => ({ available: true, can_inspect_conversation: true, can_list_unread: true, can_send: true, can_lookup_send_result: true }),
      listUnreadMessages: async () => messages,
    },
    buildContext: async () => ({ conversation_id: "conv-a", recent: [], relevant: [], estimated_tokens: 0, degraded: [] }),
    // 单元测试默认关掉理解层：避免每轮多一次模型调用打乱既有的调用次数断言。
    // 理解层本身由 wechat-reading.test.ts 与下面的专项用例覆盖。
    readInbound: async () => null,
    generate: async function* (options: ChatOptions): AsyncGenerator<ChatChunk> {
      prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      yield { type: "text", delta: "reply" };
    },
    send: async ({ body }) => { sent.push(body); controller.abort("test_done"); },
    sleep: async () => { controller.abort("test_done"); },
    limits: { proactiveIntervalMs: 24 * 3_600_000 },
  };
  return { deps, controller, turns, sent, prompts };
}

describe("wechat reply worker", () => {
  it("records one inbound turn and uses the injected send boundary", async () => {
    const h = setup();
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["reply"]);
    expect([...h.turns.values()][0]).toMatchObject({ status: "sent", generated_body: "reply" });
  });

  it("ignores unread messages from another conversation or sender", async () => {
    const h = setup([
      { message_id: "other-conv", conversation_id: "conv-b", sender_id: "alice", body: "x", received_at: "now" },
      { message_id: "other-sender", conversation_id: "conv-a", sender_id: "mallory", body: "x", received_at: "now" },
    ]);
    await runWechatReplyWorker(h.deps);
    expect(h.turns.size).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it("marks the turn skipped and does not send when stopped during generation", async () => {
    const h = setup();
    h.deps.generate = async function* () {
      h.controller.abort("user_stopped");
      yield { type: "text", delta: "must not send" };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toHaveLength(0);
    expect([...h.turns.values()][0]).toMatchObject({ status: "skipped", reason: "cancelled_before_send" });
  });

  it("does not send a generated reply after persistent authorization is revoked", async () => {
    const h = setup();
    let checks = 0;
    h.deps.store.canContinue = () => ++checks <= 1;
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toHaveLength(0);
    expect([...h.turns.values()][0]).toMatchObject({ status: "skipped", reason: "任务已暂停或历史授权已撤销" });
  });

  it("sends a proactive message when the interval elapsed and no inbound exists", async () => {
    const h = setup([]);
    h.deps.task.updated_at = new Date(Date.now() - 3_600_000).toISOString();
    h.deps.limits = { proactiveIntervalMs: 60_000 };
    let generation = 0;
    h.deps.generate = async function* () {
      generation += 1;
      yield { type: "text", delta: "主动问候" };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["主动问候"]);
    expect(generation).toBe(1);
  });

  it("injects the persona into the system prompt", async () => {
    const h = setup();
    h.deps.buildPersona = async () => ({
      target: { summary: "敏感但嘴硬", traits: ["要面子"], psychology: ["怕被忽略"], communication: ["先共情"], taboos: ["说教"], relationship: "暧昧" },
      voice: { tone: "轻松", length: "15 字", habits: ["哈哈"], addressing: "宝" },
      generated_at: "2026-11-16T10:00:00.000Z",
      source_messages: 120,
      degraded: false,
    });
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("敏感但嘴硬");
    expect(h.prompts[0]).toContain("先共情");
  });

  it("answers new inbound messages immediately instead of waiting out the cooldown", async () => {
    const h = setup();
    const sent: string[] = [];
    const sleeps: number[] = [];
    let polls = 0;
    let generation = 0;
    h.deps.transport.listUnreadMessages = async () => {
      polls += 1;
      if (polls === 1) {
        return [{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" }];
      }
      if (polls === 2) {
        return [{ message_id: "in-2", conversation_id: "conv-a", sender_id: "alice", body: "人呢", received_at: "2026-11-16T10:00:05.000Z" }];
      }
      return [];
    };
    h.deps.generate = async function* () {
      generation += 1;
      // 两条回复内容要明显不同，否则会被「别复读」护栏判成重复而放弃发送。
      yield { type: "text", delta: generation === 1 ? "在的咋了" : "刚下楼买水去了" };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
      if (sent.length === 2) h.controller.abort("done");
    };
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
      // 防御：任何一次等待都允许收尾，避免测试里出现空转循环。
      if (sleeps.length > 4) h.controller.abort("done");
    };

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual(["在的咋了", "刚下楼买水去了"]);
    // 两条必须都在秒级回出：不能出现 60s 的冷却等待。
    expect(sleeps.every((ms) => ms < 60_000)).toBe(true);
  });

  it("answers only the newest message when several arrive in one poll", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" },
      { message_id: "in-2", conversation_id: "conv-a", sender_id: "alice", body: "人呢", received_at: "2026-11-16T10:00:05.000Z" },
    ]);
    let sends = 0;
    const prompts: string[] = [];
    h.deps.generate = async function* (options: ChatOptions) {
      const last = options.messages.at(-1);
      prompts.push((last?.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      yield { type: "text", delta: "reply" };
    };
    h.deps.send = async () => {
      sends += 1;
      h.controller.abort("done");
    };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    expect(sends).toBe(1);
    expect(prompts.at(-1)).toContain("人呢");
  });

  it("still waits the proactive cooldown before an unprompted follow-up", async () => {
    const h = setup();
    const sleeps: number[] = [];
    let sends = 0;
    let generation = 0;
    h.deps.limits = { proactiveIntervalMs: 0 };
    h.deps.generate = async function* () {
      generation += 1;
      yield { type: "text", delta: `reply-${generation}` };
    };
    h.deps.send = async () => { sends += 1; };
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
      // 撞到冷却等待就结束场景：说明主动搭话确实在排队。
      if (ms >= 50_000 || sleeps.length > 6) h.controller.abort("done");
    };

    await runWechatReplyWorker(h.deps);

    expect(sends).toBe(1);
    expect(sleeps.some((ms) => ms >= 50_000)).toBe(true);
  });

  it("rewrites a repeated question instead of sending it again", async () => {
    const h = setup();
    const sent: string[] = [];
    const users: string[] = [];
    let step = 0;
    let polls = 0;
    h.deps.transport.listUnreadMessages = async () => {
      polls += 1;
      if (polls === 1) return [{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" }];
      if (polls === 2) return [{ message_id: "in-2", conversation_id: "conv-a", sender_id: "alice", body: "楼下", received_at: "2026-11-16T10:00:05.000Z" }];
      h.controller.abort("done");
      return [];
    };
    h.deps.generate = async function* (options: ChatOptions) {
      const last = options.messages.at(-1);
      users.push((last?.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      step += 1;
      // 第一轮正常；第二轮模型复读（还带编号残留）→ 触发重写；重写后换话题。
      if (step === 2) yield { type: "text", delta: "1 昨晚没见你回宿舍 哪去了" };
      else if (step === 3) yield { type: "text", delta: "行，那先不问了，你忙" };
      else yield { type: "text", delta: "你昨晚没回宿舍去哪了" };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
    };
    h.deps.sleep = async () => {};

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual(["你昨晚没回宿舍去哪了", "行，那先不问了，你忙"]);
    // 改写提示必须真的发给了模型：要么因复读、要么因「本轮不许提问」，两者都算护栏生效。
    expect(users.some((text) => text.includes("重复") || text.includes("不允许提问"))).toBe(true);
    expect(sent.every((body) => !/^\d/.test(body))).toBe(true);
  });

  it("stays silent when the rewrite is still a repeat", async () => {
    const h = setup();
    const sent: string[] = [];
    let polls = 0;
    h.deps.transport.listUnreadMessages = async () => {
      polls += 1;
      if (polls === 1) return [{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" }];
      if (polls === 2) return [{ message_id: "in-2", conversation_id: "conv-a", sender_id: "alice", body: "楼下", received_at: "2026-11-16T10:00:05.000Z" }];
      h.controller.abort("done");
      return [];
    };
    let step = 0;
    h.deps.generate = async function* () {
      step += 1;
      yield { type: "text", delta: step === 1 ? "你昨晚没回宿舍去哪了" : "昨晚没见你回宿舍 哪去了" };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
    };
    h.deps.sleep = async () => {};

    await runWechatReplyWorker(h.deps);

    // 第一轮发出去，第二轮重写后仍然重复 → 不发。
    expect(sent).toEqual(["你昨晚没回宿舍去哪了"]);
  });

  it("shortens an over-long reply that reads like an AI essay", async () => {
    const h = setup();
    const sent: string[] = [];
    let step = 0;
    h.deps.generate = async function* () {
      step += 1;
      yield {
        type: "text",
        delta: step === 1
          ? "你先别太焦虑了，体检这个东西其实也没那么可怕，明天早点睡就行"
          : "别慌 早睡",
      };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
      h.controller.abort("done");
    };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual(["别慌 早睡"]);
  });

  it("turns a direct question into a guess when the plan forbids asking", async () => {
    const h = setup();
    const sent: string[] = [];
    const users: string[] = [];
    let step = 0;
    h.deps.generate = async function* (options: ChatOptions) {
      const last = options.messages.at(-1);
      users.push((last?.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      step += 1;
      if (step === 1) {
        yield { type: "text", delta: '{"known":["他说在楼下"],"slot":"昨晚去哪","move":"ask_direct","ask_budget":0,"line":"你昨晚去哪了"}' };
        return;
      }
      yield { type: "text", delta: '{"slot":"昨晚去哪","move":"guess","ask_budget":0,"line":"我猜你是躲人去了吧"}' };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
      h.controller.abort("done");
    };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    // 计划说这轮不许问 → 直接问句被拦下，改成猜测式再发。
    expect(sent).toEqual(["我猜你是躲人去了吧"]);
    expect(users.some((text) => text.includes("不允许提问"))).toBe(true);
  });

  it("sends a budgeted first-time question unchanged", async () => {
    const h = setup();
    const sent: string[] = [];
    let calls = 0;
    h.deps.generate = async function* () {
      calls += 1;
      yield { type: "text", delta: '{"slot":"昨晚去哪","move":"ask_direct","ask_budget":1,"line":"你昨晚去哪了"}' };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
      h.controller.abort("done");
    };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual(["你昨晚去哪了"]);
    expect(calls).toBe(1);
  });

  it("remembers planned facts and refuses to ask the same slot twice", async () => {
    const h = setup();
    const sent: string[] = [];
    const systems: string[] = [];
    let polls = 0;
    h.deps.transport.listUnreadMessages = async () => {
      polls += 1;
      if (polls === 1) return [{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" }];
      if (polls === 2) return [{ message_id: "in-2", conversation_id: "conv-a", sender_id: "alice", body: "楼下", received_at: "2026-11-16T10:00:05.000Z" }];
      h.controller.abort("done");
      return [];
    };
    let step = 0;
    h.deps.generate = async function* (options: ChatOptions) {
      systems.push((options.messages[0]?.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      step += 1;
      if (step === 1) {
        yield { type: "text", delta: '{"known":["他在楼下"],"slot":"昨晚去哪","move":"ask_direct","ask_budget":1,"line":"你昨晚去哪了"}' };
        return;
      }
      if (step === 2) {
        // 同一个 slot，模型仍想直接问 → 应被「同槽只问一次」拦下并改写。
        yield { type: "text", delta: '{"known":["他在楼下"],"slot":"昨晚去哪","move":"ask_direct","ask_budget":1,"line":"你昨晚到底去哪了"}' };
        return;
      }
      yield { type: "text", delta: '{"slot":"昨晚去哪","move":"guess","ask_budget":0,"line":"我猜你打游戏去了"}' };
    };
    h.deps.send = async ({ body }) => {
      sent.push(body);
    };
    h.deps.sleep = async () => {};

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual(["你昨晚去哪了", "我猜你打游戏去了"]);
    // 第二轮的系统提示里必须能看到第一轮记下的已知信息与「已问过」的信息点。
    expect(systems.some((text) => text.includes("他在楼下"))).toBe(true);
    expect(systems.some((text) => text.includes("已经在" ) || text.includes("已经直接问过"))).toBe(true);
  });

  it("never sends a truncated plan JSON to the contact", async () => {
    const h = setup();
    const sent: string[] = [];
    h.deps.generate = async function* () {
      // 真实事故原样：模型输出被截断在 known 里，没有 line。
      yield { type: "text", delta: '{"known":["对方说去年看过分公司招聘","对方让我看今年的招聘信息' };
    };
    h.deps.send = async ({ body }) => { sent.push(body); };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    expect(sent).toEqual([]);
  });

  it("feeds the freshest messages read from WeChat into the prompt", async () => {
    const h = setup();
    const messages: string[] = [];
    h.deps.transport.listRecentMessages = async () => [
      { role: "me" as const, body: "我刚说我在楼下", received_at: "2026-11-17T14:30:00", ts_ms: Date.parse("2026-11-17T14:30:00+08:00") },
      { role: "them" as const, body: "我也在楼下", received_at: "2026-11-17T14:30:30", ts_ms: Date.parse("2026-11-17T14:30:30+08:00") },
    ];
    h.deps.generate = async function* (options: ChatOptions) {
      for (const message of options.messages) {
        messages.push((message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""));
      }
      yield { type: "text", delta: '{"move":"mirror","ask_budget":0,"line":"那正好"}' };
    };
    h.deps.send = async ({ body }) => {
      h.sent.push(body);
      h.controller.abort("done");
    };
    h.deps.sleep = async () => { h.controller.abort("done"); };

    await runWechatReplyWorker(h.deps);

    const history = messages.join("\n");
    expect(history).toContain("我刚说我在楼下");
    expect(history).toContain("对方：我也在楼下");
    expect(h.sent).toEqual(["那正好"]);
  });

  it("survives a provider-busy burst instead of counting failures and pausing", async () => {
    const h = setup();
    let attempts = 0;
    const raw = async function* (): AsyncGenerator<ChatChunk> {
      attempts += 1;
      if (attempts <= 6) throw Object.assign(new Error("429 rate limit"), { code: "RATE_LIMIT", status: 429 });
      yield { type: "text", delta: "在的" };
    };
    h.deps.generate = withModelRetry(raw, { sleep: async () => {} });

    await runWechatReplyWorker(h.deps);

    expect(attempts).toBe(7);
    expect(h.sent).toEqual(["在的"]);
    expect([...h.turns.values()][0]).toMatchObject({ status: "sent", generated_body: "在的" });
  });

  it("still pauses after real generation failures that are not retryable", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "hello", received_at: "2026-11-16T10:00:00.000Z" },
    ]);
    let attempts = 0;
    const raw = async function* (): AsyncGenerator<ChatChunk> {
      attempts += 1;
      throw Object.assign(new Error("model not found"), { code: "INVALID_REQUEST" });
    };
    h.deps.generate = withModelRetry(raw, { sleep: async () => {} });
    const sleeps: number[] = [];
    h.deps.sleep = async () => { sleeps.push(0); if (sleeps.length > 3) h.controller.abort("done"); };
    h.deps.store.canContinue = () => true;

    await runWechatReplyWorker(h.deps);

    expect(attempts).toBe(1);
    expect(h.sent).toHaveLength(0);
    expect([...h.turns.values()][0]).toMatchObject({ status: "failed" });
  });

  it("injects a vagueness instruction when the contact asks for sensitive info", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "把你身份证号发我一下", received_at: "2026-11-16T10:00:00.000Z" },
    ]);
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("打马虎眼");
    expect(h.prompts[0]).toContain("证件号");
  });

  it("vetoes a reply that would leak an ID number", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "你身份证多少", received_at: "2026-11-16T10:00:00.000Z" },
    ]);
    const leak = '{"known":[],"slot":"","move":"mirror","ask_budget":0,"line":"我身份证是110101199003078888"}';
    h.deps.generate = async function* () { yield { type: "text", delta: leak }; };
    h.deps.send = async () => { h.sent.push("should-not-send"); };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toHaveLength(0);
    expect([...h.turns.values()][0]).toMatchObject({ status: "skipped", reason: "empty_generation" });
  });

  it("restores persisted facts and stage goal on restart", async () => {
    const h = setup();
    h.deps.store.loadProgress = () => ({ facts: [{ text: "对方在准备考试", kind: "known" as const }], askedSlots: ["考试科目"], stageGoal: "什么时候考完" });
    h.deps.generate = async function* (options: ChatOptions) {
      h.prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      yield { type: "text", delta: "reply" };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("对方在准备考试");
    expect(h.prompts[0]).toContain("什么时候考完");
  });

  it("tells the model to follow a redirect instead of pushing the objective", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "别扯开话题，现在背诵", received_at: "2026-11-16T10:00:00.000Z" },
    ]);
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("顺着他");
    expect(h.prompts[0]).toContain("别扯开话题");
  });

  it("tells the model not to leave a one-word ack hanging", async () => {
    const h = setup([
      { message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "可以", received_at: "2026-11-16T10:00:00.000Z" },
    ]);
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("别晾着");
  });

  it("stops a same-move same-slot loop on its third consecutive turn", async () => {
    const h = setup();
    let polls = 0;
    let gen = 0;
    h.deps.transport.listUnreadMessages = async () => {
      polls += 1;
      if (polls <= 3) return [{ message_id: `in-${polls}`, conversation_id: "conv-a", sender_id: "alice", body: "背", received_at: `2026-11-16T10:00:0${polls}.000Z` }];
      h.controller.abort("done");
      return [];
    };
    h.deps.generate = async function* () {
      gen += 1;
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "背诗", move: "tease", ask_budget: 0, line: `背${gen}` }) };
    };
    h.deps.send = async ({ body }) => { h.sent.push(body); };
    h.deps.sleep = async () => {};

    await runWechatReplyWorker(h.deps);

    expect(h.sent).toEqual(["背1", "背2"]);
    expect([...h.turns.values()][2]).toMatchObject({ status: "skipped", reason: "empty_generation" });
  });

  it("strips randomly appended emoji before sending", async () => {
    const h = setup();
    h.deps.generate = async function* () {
      yield { type: "text", delta: '{"known":[],"move":"mirror","ask_budget":0,"line":"那你这运动量够了[坏笑]"}' };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["那你这运动量够了"]);
  });

  it("waits the injected send jitter before sending", async () => {
    const h = setup();
    let jitterCalls = 0;
    h.deps.sendJitterMs = () => { jitterCalls += 1; return 1; };
    await runWechatReplyWorker(h.deps);
    expect(jitterCalls).toBe(1);
    expect(h.sent).toEqual(["reply"]);
  });

  it("waits for the debounce window before replying", async () => {
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在吗", received_at: "2026-11-16T10:00:00.000Z" }]);
    const start = Date.parse("2026-11-16T10:00:00.000Z");
    let clock = start;
    h.deps.now = () => new Date(clock);
    h.deps.sleep = async (ms) => { clock += ms; };
    h.deps.limits = { debounceMs: 1_000, debounceMaxMs: 5_000, proactiveIntervalMs: 24 * 3_600_000 };
    h.deps.send = async ({ body }) => { h.sent.push(body); h.controller.abort("done"); };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["reply"]);
    // 必须等过静默窗口才回，不能第一轮就抢答。
    expect(clock - start).toBeGreaterThanOrEqual(1_000);
  });

  it("does not send a reply that promises on the user's behalf", async () => {
    const h = setup();
    h.deps.generate = async function* () {
      yield { type: "text", delta: '{"known":[],"slot":"","move":"mirror","ask_budget":0,"line":"我保证给你答复"}' };
    };
    h.deps.send = async () => { h.sent.push("should-not-send"); };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toHaveLength(0);
    expect([...h.turns.values()][0]).toMatchObject({ status: "skipped", reason: "empty_generation" });
  });

  it("injects shared memory into the five-layer system prompt", async () => {
    const h = setup();
    h.deps.buildPersona = async () => ({
      target: { summary: "", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "" },
      shared: { facts: ["在准备软考高级"], timeline: ["11-14 面试挂了"], people: ["班长"] },
      generated_at: "2026-11-16T10:00:00.000Z", source_messages: 4, degraded: false,
    });
    h.deps.generate = async function* (options: ChatOptions) {
      h.prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      yield { type: "text", delta: "reply" };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("Layer 0");
    expect(h.prompts[0]).toContain("共同记忆");
    expect(h.prompts[0]).toContain("在准备软考高级");
  });

  it("forces a reply when the contact asks a question and the model tries to stay silent", async () => {
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "怎么说", received_at: "2026-11-16T10:00:00.000Z" }]);
    let calls = 0;
    h.deps.generate = async function* () {
      calls += 1;
      const line = calls === 1 ? "" : "就软件升级了";
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: calls === 1 ? "silent" : "mirror", ask_budget: 0, line }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(calls).toBe(2);
    expect(h.sent).toEqual(["就软件升级了"]);
  });

  it("does not feed the bot's own lines back as the user's speaking style", async () => {
    // 真实事故：聊天库里 role=me 混着用户手打的机器人代发的，模型把自己的腔调学回去了。
    const h = setup();
    // 历史授权关着时 worker 直接走空上下文，风格样本拿不到 → 这条必须开着才测得到。
    h.deps.task.history_authorized = true;
    h.deps.buildContext = async () => ({
      conversation_id: "conv-a",
      recent: [
        { role: "me", content: "回来了吗" },
        { role: "me", content: "我猜是中杯可乐那套" },
        { role: "them", content: "并非" },
      ],
      relevant: [],
      estimated_tokens: 0,
      degraded: [],
    });
    h.deps.listOwnSentBodies = () => ["我猜是中杯可乐那套"];
    h.deps.generate = async function* (options: ChatOptions) {
      h.prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      yield { type: "text", delta: "reply" };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("回来了吗");
    expect(h.prompts[0]).not.toContain("我猜是中杯可乐那套");
  });

  it("rewrites a reply that talks about the contact like a bystander", async () => {
    // 真实事故：「骂人还挺快 装完记得给反馈」——在评价对方，不像当事人在聊天。
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "你有病啊", received_at: "2026-11-16T10:00:00.000Z" }]);
    let calls = 0;
    h.deps.generate = async function* () {
      calls += 1;
      const line = calls === 1 ? "骂人还挺快 装完记得给反馈" : "你才有病 装完给我说声";
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "tease", ask_budget: 0, line }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(calls).toBe(2);
    expect(h.sent).toEqual(["你才有病 装完给我说声"]);
  });

  it("keeps an emoji the user actually uses when the draw allows it", async () => {
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在干嘛", received_at: "2026-11-16T10:00:00.000Z" }]);
    h.deps.random = () => 0; // 抽中：这一条允许带表情
    h.deps.buildPersona = async () => ({
      target: { summary: "", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "", emoji: { rate: 0.05, total: 3, messages: 60, repertoire: ["[旺柴]"] } },
      generated_at: "2026-11-16T10:00:00.000Z", source_messages: 20, degraded: false,
    });
    h.deps.generate = async function* () {
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "mirror", ask_budget: 0, line: "行吧[旺柴]" }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["行吧[旺柴]"]);
  });

  it("strips an emoji that is not in the user's repertoire", async () => {
    // 真实事故：模型自己在语境不搭的地方挂了 [呲牙]。
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在干嘛", received_at: "2026-11-16T10:00:00.000Z" }]);
    h.deps.random = () => 0;
    h.deps.buildPersona = async () => ({
      target: { summary: "", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "", emoji: { rate: 0.05, total: 3, messages: 60, repertoire: ["[旺柴]"] } },
      generated_at: "2026-11-16T10:00:00.000Z", source_messages: 20, degraded: false,
    });
    h.deps.generate = async function* () {
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "mirror", ask_budget: 0, line: "行吧[呲牙]" }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["行吧"]);
  });

  it("strips any emoji when this message did not win the emoji draw", async () => {
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "在干嘛", received_at: "2026-11-16T10:00:00.000Z" }]);
    h.deps.random = () => 0.99; // 没抽中
    h.deps.buildPersona = async () => ({
      target: { summary: "", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "", emoji: { rate: 0.05, total: 3, messages: 60, repertoire: ["[旺柴]"] } },
      generated_at: "2026-11-16T10:00:00.000Z", source_messages: 20, degraded: false,
    });
    h.deps.generate = async function* () {
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "mirror", ask_budget: 0, line: "行吧[旺柴]" }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["行吧"]);
  });

  it("still replies when the contact writes in English instead of staying silent", async () => {
    // 真实事故：对方回「I can't understand Chinese」，模型直接 empty_generation，聊天断在那里。
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "I can't understand Chinese", received_at: "2026-11-16T10:00:00.000Z" }]);
    let calls = 0;
    h.deps.generate = async function* () {
      calls += 1;
      const line = calls === 1 ? "" : "oh my bad";
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: calls === 1 ? "silent" : "mirror", ask_budget: 0, line }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(calls).toBe(2);
    expect(h.sent).toEqual(["oh my bad"]);
  });

  it("allows silence only when the contact is wrapping up", async () => {
    const h = setup([{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body: "晚安", received_at: "2026-11-16T10:00:00.000Z" }]);
    let calls = 0;
    h.deps.generate = async function* () {
      calls += 1;
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "silent", ask_budget: 0, line: "" }) };
    };
    await runWechatReplyWorker(h.deps);
    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(0);
  });
});

/**
 * 把这两天真实发生的事故固化成回归用例。
 *
 * 这些事故的共同点：**不是措辞问题，是模型没有先读懂对方那句话**。
 * 所以这里断言的是「理解层的结论确实变成了生成阶段的硬指令」，
 * 以及「此刻状态缺失时禁止编造」。
 */
describe("reply regressions: 真实事故", () => {
  function reading(overrides: Partial<import("../src/wechat-reading.js").Reading> = {}) {
    return {
      intent: "question" as const,
      presupposition: "",
      presupposition_holds: true,
      challenges_my_last_line: false,
      must_answer: false,
      needs_realtime_state: false,
      ...overrides,
    };
  }

  function inbound(body: string) {
    return [{ message_id: "in-1", conversation_id: "conv-a", sender_id: "alice", body, received_at: "2026-11-16T10:00:00.000Z" }];
  }

  /** 让模型只回一句固定文案，并把 system prompt 收集下来。 */
  function replyWith(h: ReturnType<typeof setup>, line: string) {
    h.deps.generate = async function* (options: ChatOptions) {
      h.prompts.push(options.messages[0]?.content.map((part) => ("text" in part ? part.text : "")).join("") ?? "");
      yield { type: "text", delta: JSON.stringify({ known: [], slot: "", move: "self_disclose", ask_budget: 0, line }) };
    };
  }

  it("1) 建阳税务局：招聘信息不能演成「我报过」", async () => {
    const h = setup(inbound("你不是不考公？"));
    h.deps.readInbound = async () => reading({
      intent: "challenge",
      presupposition: "我考过公",
      presupposition_holds: false,
      challenges_my_last_line: true,
      must_answer: true,
    });
    replyWith(h, "没报过 就看到过招聘");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("「我考过公」");
    expect(h.prompts[0]).toContain("不许顺着它往下演");
    expect(h.sent).toEqual(["没报过 就看到过招聘"]);
  });

  it("2) 写作业吗：假前提要先纠正", async () => {
    const h = setup(inbound("写作业吗"));
    h.deps.readInbound = async () => reading({
      intent: "challenge",
      presupposition: "我有作业要写",
      presupposition_holds: false,
      challenges_my_last_line: true,
      must_answer: true,
    });
    replyWith(h, "没作业 别瞎说");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("「我有作业要写」");
    expect(h.prompts[0]).toContain("先把这个前提纠正掉");
    expect(h.sent).toEqual(["没作业 别瞎说"]);
  });

  it("3) 忙啥呢：必须给实质内容，不许反问", async () => {
    const h = setup(inbound("忙啥呢"));
    h.deps.readInbound = async () => reading({ must_answer: true });
    replyWith(h, "在改代码 一堆报错");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("必须给出实质内容");
    expect(h.prompts[0]).toContain("不许用「你呢」弹回去");
    expect(h.sent).toEqual(["在改代码 一堆报错"]);
  });

  it("4) 对方已说「下了」：不许再问下班干什么", async () => {
    const h = setup(inbound("忙啥呢"));
    h.deps.readInbound = async () => reading({ must_answer: true, challenges_my_last_line: false });
    replyWith(h, "在收拾东西");
    await runWechatReplyWorker(h.deps);
    // 时序由理解层 + 事实/历史共同保证；这里确认硬指令已注入。
    expect(h.prompts[0]).toContain("必须给出实质内容");
    expect(h.sent).toEqual(["在收拾东西"]);
  });

  it("5) 对方说英文：reading 判必须回答时必须开口", async () => {
    const h = setup(inbound("I can't understand Chinese"));
    h.deps.readInbound = async () => reading({ intent: "challenge", must_answer: true });
    replyWith(h, "my bad");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("必须给出实质内容");
    expect(h.sent).toEqual(["my bad"]);
  });

  it("6) 装了→没装：质疑上一句时要求解释依据而不是翻供", async () => {
    const h = setup(inbound("你装了吗"));
    h.deps.readInbound = async () => reading({
      intent: "challenge",
      challenges_my_last_line: true,
      must_answer: true,
    });
    replyWith(h, "装了阿 不然我升级个啥");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("对方在质疑你上一句");
    expect(h.prompts[0]).toContain("不许换话题、不许反问");
    expect(h.sent).toEqual(["装了阿 不然我升级个啥"]);
  });

  it("7) [类型50]：占位符不会被当成表情发出去", async () => {
    const h = setup(inbound("在干嘛"));
    h.deps.random = () => 0;
    h.deps.buildPersona = async () => ({
      target: { summary: "", traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "", emoji: { rate: 0.05, total: 3, messages: 60, repertoire: ["[类型50]"] } },
      generated_at: "2026-11-16T10:00:00.000Z", source_messages: 20, degraded: false,
    });
    replyWith(h, "刚下班[类型50]");
    await runWechatReplyWorker(h.deps);
    expect(h.sent).toEqual(["刚下班"]);
  });

  it("8) 此刻状态未配置：禁止编造具体场景", async () => {
    const h = setup(inbound("吃了吗"));
    replyWith(h, "还没吃");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("不许编具体场景");
    expect(h.prompts[0]).toContain("在教室/在宿舍/还没吃饭");
  });

  it("8b) 此刻状态已配置：只允许依据它说", async () => {
    const h = setup(inbound("吃了吗"));
    h.deps.currentState = () => "在上课";
    replyWith(h, "在上课 还没吃");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("【此刻】在上课");
    expect(h.prompts[0]).toContain("只能依据这一条");
  });

  it("9) 对方说他毕业了：不许套到自己身上，也不许否认在读", async () => {
    // 真实事故：对方「我当时已经毕业了啊」→ 问「那你现在在哪个学校？」→ 代理回「我早不读了」。
    const h = setup(inbound("那你现在在哪个学校？"));
    h.deps.identity = () => "23 岁，泉州师范学院软件工程本科在读，2027 届应届生";
    replyWith(h, "泉州师范 还在读");
    await runWechatReplyWorker(h.deps);
    expect(h.prompts[0]).toContain("【我是谁】");
    expect(h.prompts[0]).toContain("本科在读");
    expect(h.prompts[0]).toContain("绝不套到自己身上");
    expect(h.prompts[0]).toContain("不许否认");
    expect(h.sent).toEqual(["泉州师范 还在读"]);
  });
});
