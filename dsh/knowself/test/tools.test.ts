import { describe, it, expect, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { registerAll, apply } from "../src/index.js";
import { makeTools } from "../src/tools.js";
import { registerSystemPrompt } from "../src/system-prompt.js";
import { Config } from "../src/config.js";
import {
  type KnowselfServices,
  pickRetrievalProviderId,
} from "../src/services.js";
import { makeIngestionProposalSink } from "../src/proposal-sink.js";

// A1-3：让 createRealServices 抛错，验证 apply 降级路径（不破坏其他测试的桩服务）。
vi.mock("../src/services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services.js")>();
  return {
    ...actual,
    createRealServices: async () => {
      throw new Error("A1-3 sim: no provider configured / offline");
    },
  };
});

/**
 * 桩服务：用内存假对象满足 KnowselfServices 接口，覆盖全部 16 个工具，
 * 不触网、不读写真实 SQLite。
 */
function makeStubServices(): KnowselfServices {
  const core = {
    display_name: "TestUser",
    locale: "zh-CN",
    section_tags: ["work", "family"],
    body: "示例画像正文",
    updated_at: "2026-01-01",
    schema_version: 1 as const,
  };
  const cardsList = [
    { key: "k1", title: "T1", summary: "s", section_tags: [], updated_at: "2026-01-01" },
  ];
  const profileStore = {
    core: { get: () => core },
    cards: {
      list: () => cardsList,
      get: (key: string) =>
        key === "k1"
          ? {
              card: { key, title: "T1", summary: "s", section_tags: [], updated_at: "", schema_version: 1 },
              sections: [],
            }
          : null,
    },
    journal: { get: () => ({ date: "2026-01-01", records: [] }) },
    write: (_req: unknown, _ctx: unknown) => {},
  } as unknown as KnowselfServices["profileStore"];

  const personStore = {
    listPersons: () => [],
    getPerson: (id: string) =>
      id === "p1" ? ({ person_id: "p1", display_name: "P1" } as never) : null,
    events: { timeline: () => [] },
    // 满足 MiningReadStore：metrics 列表接口（供 getPersonMetrics / getGraphSnapshot 调用）
    metrics: { list: () => [], listGraphSnapshots: () => [] },
  } as unknown as KnowselfServices["personStore"];

  const contextRouter = {
    buildContext: async () => ({
      messages: [{ role: "user", content: "x" }],
      metadata: { total_tokens: 1 },
    }),
  } as unknown as KnowselfServices["contextRouter"];

  const ingestion = {
    createSource: async () => ({ id: "s1", status: "pending" }),
    runDistill: async () => ({ proposals: [{ id: "pr1" }] }),
    listProposalsByStatus: () => [],
    acceptProposal: () => ({ id: "pr1", status: "accepted" }),
    acceptSourceDistillProposal: async () => ({ id: "pr1", status: "accepted" }),
    editProposal: () => ({ id: "pr1", status: "edited" }),
    rejectProposal: () => ({ id: "pr1", status: "rejected" }),
  } as unknown as KnowselfServices["ingestion"];

  const chatIngest = {
    ingestExport: async () => ({ imported: 0, warnings: [] }),
    createChatMessageCommitter: () => ({ commit: () => ({ committed: 0, skipped: 0 }) }),
  } as unknown as KnowselfServices["chatIngest"];

  return {
    rootDir: "/tmp/knowself-test",
    settings: {} as never,
    paths: {} as never,
    profileStore,
    personStore,
    contextRouter,
    ingestion,
    chatIngest,
  };
}

/** 每个工具的样例入参。 */
const SAMPLE_ARGS: Record<string, unknown> = {
  knowself_get_profile: {},
  knowself_get_card: { key: "k1" },
  knowself_list_cards: {},
  knowself_search: { query: "你好", provider_id: "p" },
  knowself_get_journal: { date: "2026-01-01" },
  knowself_append_journal: { body: "今天天气不错" },
  knowself_list_persons: { keyword: "a" },
  knowself_get_person: { person_id: "p1" },
  knowself_person_events: { person_id: "p1" },
  knowself_metrics: { person_id: "p1" },
  knowself_network: { scope_kind: "person" },
  knowself_intent: { messages: [{ message_id: "m1", content: "你好" }] },
  knowself_ingest: { kind: "paste", text: "一段资料文本" },
  knowself_list_proposals: { status: "pending" },
  knowself_decide_proposal: { decision: "accept", proposal_id: "pr1" },
  knowself_import_chat: { dir: "/tmp" },
};

describe("makeTools", () => {
  const services = makeStubServices();

  it("生成恰好 16 个工具且命名正确", () => {
    const tools = makeTools(services);
    expect(tools).toHaveLength(16);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "knowself_append_journal",
        "knowself_decide_proposal",
        "knowself_get_card",
        "knowself_get_journal",
        "knowself_get_person",
        "knowself_get_profile",
        "knowself_import_chat",
        "knowself_ingest",
        "knowself_list_cards",
        "knowself_intent",
        "knowself_list_persons",
        "knowself_list_proposals",
        "knowself_metrics",
        "knowself_network",
        "knowself_person_events",
        "knowself_search",
      ].sort(),
    );
  });

  it("每个工具都有 parameters / output.render / execute", () => {
    for (const t of makeTools(services)) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.parameters).toBe("object");
      expect(typeof t.output.render).toBe("function");
      expect(typeof t.execute).toBe("function");
    }
  });

  // 每个工具至少 1 个单测：execute 能跑通且产出 canonical JSON。
  for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
    it(`${name} execute 返回结构化结果`, async () => {
      const tool = makeTools(services).find((t) => t.name === name);
      expect(tool, `工具 ${name} 应存在`).toBeDefined();
      const result = await tool!.execute(args, {
        signal: new AbortController().signal,
        deferContext: () => {},
        concludeTurn: () => {},
      } as never);
      // 渲染投影能产出文本块
      const blocks = tool!.output.render(args, result as never);
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
    });
  }
});

describe("source_distill 工具决议", () => {
  it("accept 调用异步蒸馏入口，且列表工具接受 processing", async () => {
    const services = makeStubServices();
    const acceptProposal = vi.fn();
    const acceptSourceDistillProposal = vi.fn(async () => ({ id: "review-1", status: "accepted" }));
    const listProposalsByStatus = vi.fn((status: string) =>
      status === "pending"
        ? [
            {
              id: "review-1",
              target: { kind: "source_distill", confidence: 0.4 },
            },
          ]
        : [],
    );
    services.ingestion = {
      ...(services.ingestion as NonNullable<KnowselfServices["ingestion"]>),
      acceptProposal,
      acceptSourceDistillProposal,
      listProposalsByStatus,
    };

    const tools = makeTools(services);
    const decide = tools.find((tool) => tool.name === "knowself_decide_proposal");
    const list = tools.find((tool) => tool.name === "knowself_list_proposals");
    await decide!.execute(
      { proposal_id: "review-1", decision: "accept" },
      { signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {} } as never,
    );
    await list!.execute(
      { status: "processing" },
      { signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {} } as never,
    );

    expect(acceptSourceDistillProposal).toHaveBeenCalledWith("review-1");
    expect(acceptProposal).not.toHaveBeenCalled();
    expect(listProposalsByStatus).toHaveBeenCalledWith("processing", undefined);
  });
});

describe("cordis 级挂载验证（HANDOFF 验收口径：ctx.plugin 挂载 + 断言服务调用）", () => {
  it("ctx.plugin(插件) 挂载后向 ctx.tools 注册 16 个 knowself_* 工具，并调用 systemPrompt.section / settings.configure", async () => {
    // 真实 cordis 根上下文（替代 dsh 宿主在运行时注入的 tools/systemPrompt/settings）
    const root = new Context();

    const registered: Record<string, unknown>[] = [];
    const sections: Record<string, unknown>[] = [];
    const configs: Record<string, unknown>[] = [];

    // 用真实 cordis 服务注入机制挂桩
    root.provide("tools", {
      register: (def: Record<string, unknown>) => {
        registered.push(def);
        return () => {};
      },
    });
    root.provide("systemPrompt", {
      section: (s: Record<string, unknown>) => {
        sections.push(s);
        return () => {};
      },
    });
    root.provide("settings", {
      configure: (c: Record<string, unknown>) => {
        configs.push(c);
        return () => {};
      },
    });

    // 直接 ctx.plugin 挂载（HANDOFF 指定验收方式）。
    // 用桩服务执行 registerAll，验证「注册行为」本身被正确触发（不触网、不开 DB）。
    await root.plugin(async (c) => {
      await registerAll(
        c as unknown as Parameters<typeof registerAll>[0],
        makeStubServices(),
      );
    });

    expect(registered).toHaveLength(16);
    expect(
      registered.every(
        (t) =>
          typeof t.name === "string" &&
          t.name.startsWith("knowself_") &&
          typeof t.execute === "function" &&
          typeof t.output?.render === "function",
      ),
    ).toBe(true);

    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("knowself-l1");

    expect(configs).toHaveLength(1);
    expect(configs[0]).toEqual({ auto: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1-1: knowself_search 的 provider_id 降级（缺省从 settings.providers 推导）
// ─────────────────────────────────────────────────────────────────────────────
describe("A1-1: knowself_search provider_id 降级", () => {
  function servicesWithProviders(providers: unknown[]): KnowselfServices {
    const base = makeStubServices();
    const captured: { input?: unknown } = {};
    base.contextRouter = {
      buildContext: async (input: unknown) => {
        captured.input = input;
        return { messages: [{ role: "user", content: "x" }], metadata: { total_tokens: 1 } };
      },
    } as unknown as KnowselfServices["contextRouter"];
    (base as { _captured?: { input?: unknown } })._captured = captured;
    return { ...base, settings: { providers } as never };
  }

  it("pickRetrievalProviderId: purpose 含 chat/rerank 优先，否则第一个，无则 undefined", () => {
    expect(
      pickRetrievalProviderId({
        providers: [
          { id: "a", purposes: ["chat"] },
          { id: "b" },
        ],
      } as never),
    ).toBe("a");
    expect(
      pickRetrievalProviderId({ providers: [{ id: "b" }] } as never),
    ).toBe("b");
    expect(pickRetrievalProviderId({ providers: [] } as never)).toBeUndefined();
  });

  it("不传 provider_id 时从 settings.providers 推导（rerank 命中）", async () => {
    const services = servicesWithProviders([
      { id: "prov-rerank", purposes: ["rerank"] },
      { id: "prov-first", purposes: ["distill"] },
    ]);
    const tool = makeTools(services).find((t) => t.name === "knowself_search")!;
    await tool.execute({ query: "你好" }, {} as never);
    const input = (services as { _captured: { input?: { provider_id?: string } } })._captured
      .input as { provider_id?: string };
    expect(input.provider_id).toBe("prov-rerank");
  });

  it("无 chat/rerank 时退化为第一个 provider", async () => {
    const services = servicesWithProviders([{ id: "prov-first", purposes: ["distill"] }]);
    const tool = makeTools(services).find((t) => t.name === "knowself_search")!;
    await tool.execute({ query: "你好" }, {} as never);
    const input = (services as { _captured: { input?: { provider_id?: string } } })._captured
      .input as { provider_id?: string };
    expect(input.provider_id).toBe("prov-first");
  });

  it("显式传入 provider_id 不被推导覆盖", async () => {
    const services = servicesWithProviders([
      { id: "prov-rerank", purposes: ["rerank"] },
    ]);
    const tool = makeTools(services).find((t) => t.name === "knowself_search")!;
    await tool.execute({ query: "你好", provider_id: "explicit" }, {} as never);
    const input = (services as { _captured: { input?: { provider_id?: string } } })._captured
      .input as { provider_id?: string };
    expect(input.provider_id).toBe("explicit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1-2: import_chat 接入真实 ingestion 提案系统（pipeline 路径）
// ─────────────────────────────────────────────────────────────────────────────
describe("A1-2: import_chat 真实 ingestion 提案链路", () => {
  it("pipeline 路径的 proposalSink 调用真实 ingestion 提案接口", async () => {
    const base = makeStubServices();
    const calls = { listPending: 0, create: 0, accept: 0 };

    base.ingestion = {
      ...base.ingestion,
      listProposalsByStatus: (() => {
        calls.listPending++;
        return [];
      }) as unknown as KnowselfServices["ingestion"]["listProposalsByStatus"],
      acceptProposal: (() => {
        calls.accept++;
        return { id: "pX", status: "accepted" } as never;
      }) as unknown as KnowselfServices["ingestion"]["acceptProposal"],
    } as unknown as KnowselfServices["ingestion"];

    base.profileStore = {
      ...base.profileStore,
      proposals: {
        insertMany: (() => {
          calls.create++;
        }) as unknown as KnowselfServices["profileStore"]["proposals"]["insertMany"],
      },
    } as unknown as KnowselfServices["profileStore"];

    // 捕获 ingestion 真正落库前的 sink，并模拟 pipeline 调用 sink
    let sink: ReturnType<typeof makeIngestionProposalSink> | undefined;
    base.chatIngest = {
      ingestExport: async (opts: { proposalSink?: unknown }) => {
        sink = opts.proposalSink as ReturnType<typeof makeIngestionProposalSink>;
        sink!.listPending({ conversation_id: "c1" });
        sink!.create({
          id: "pX",
          source_id: "s1",
          target: {
            kind: "chat_message",
            batch_id: "b1",
            conversation_id: "c1",
            message_ids: ["m1"],
            tier: "review",
            reason_codes: [],
          },
          proposed_body: "摘要",
          reasoning: "",
          source_excerpts: [],
          produced_by_provider: "prov",
          status: "pending",
          user_edited_body: null,
          created_at: new Date().toISOString(),
          decided_at: null,
        } as never);
        sink!.accept("pX");
        return { imported: 0, warnings: [] };
      },
      createChatMessageCommitter: () => ({ commit: () => ({ committed: 0, skipped: 0 }) }),
    } as unknown as KnowselfServices["chatIngest"];

    const tool = makeTools(base).find((t) => t.name === "knowself_import_chat")!;
    await tool.execute({ dir: "/tmp", source_id: "s1" }, {} as never);

    expect(sink).toBeDefined();
    expect(calls.listPending).toBeGreaterThan(0);
    expect(calls.create).toBeGreaterThan(0);
    expect(calls.accept).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1-3: apply 装载失败降级（createRealServices 抛错 → 不崩溃、不注册、记日志）
// ─────────────────────────────────────────────────────────────────────────────
describe("A1-3: apply 装载失败降级", () => {
  it("createRealServices 抛错时不崩溃：不注册任何工具并记录错误日志", async () => {
    const root = new Context();
    const registered: unknown[] = [];
    const captured: any[] = [];

    root.provide("tools", {
      register: (def: unknown) => {
        registered.push(def);
        return () => {};
      },
    });
    root.provide("systemPrompt", { section: () => () => {} });
    root.provide("settings", { configure: () => () => {} });

    // 观测日志：向 cordis 默认 logger 服务注册 exporter（官方观测方式）
    const loggerSvc = (root as unknown as { logger: { exporter(e: { export(m: any): void }): unknown } })
      .logger;
    loggerSvc.exporter({ export: (msg: any) => captured.push(msg) });

    // createRealServices 已被 vi.mock 设为抛错
    await root.plugin(apply);

    expect(registered).toHaveLength(0);
    expect(
      captured.some(
        (m) => m.type === "error" && JSON.stringify(m.args).includes("装配失败"),
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 / T02：16 个工具 parameters 均非空（D1/P0 回归，旧断言只查 typeof === object）
// ─────────────────────────────────────────────────────────────────────────────
describe("W2/T02：16 个工具 parameters 均非空", () => {
  const services = makeStubServices();

  it("逐个遍历 16 个工具，Object.keys(parameters).length > 0", () => {
    const tools = makeTools(services);
    expect(tools).toHaveLength(16);
    for (const tool of tools) {
      const keys = Object.keys(tool.parameters as Record<string, unknown>);
      console.log(`[w2-report] ${tool.name} -> ${keys.length}`);
      expect(keys.length, `${tool.name} 的 parameters 不应为空`).toBeGreaterThan(0);
      expect(
        () => assertSupportedJsonSchema(tool.parameters),
        `${tool.name} 未通过 dsh 校验`,
      ).not.toThrow();
    }
  });

  it("knowself_ingest.parameters.oneOf.length === 3（手写 schema 生效）", () => {
    const tool = makeTools(services).find((t) => t.name === "knowself_ingest")!;
    const parameters = tool.parameters as { oneOf?: unknown[] };
    console.log(
      `[w2-report] knowself_ingest.parameters.oneOf.length = ${parameters.oneOf?.length ?? 0}`,
    );
    expect(parameters.oneOf).toHaveLength(3);
  });

  it("append_journal.parameters 不含 provenance（T03：模型不可指定）", () => {
    const tool = makeTools(services).find((t) => t.name === "knowself_append_journal")!;
    const parameters = tool.parameters as { properties?: Record<string, unknown> };
    expect(Object.keys(parameters.properties ?? {})).not.toContain("provenance");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 / T03：L1 注入函数化 + 关插值
// ─────────────────────────────────────────────────────────────────────────────
describe("W2/T03：L1 注入函数化 + 关插值", () => {
  interface CapturedSection {
    name: string;
    order: number;
    text: string | (() => string);
    interpolate?: boolean;
  }

  it("每次组装重算 text；改 profile 后同进程结果变化；{{x}} 原样保留", async () => {
    const services = makeStubServices();
    const sections: CapturedSection[] = [];
    const ctx = {
      systemPrompt: {
        section: (s: CapturedSection) => {
          sections.push(s);
          return () => {};
        },
      },
    } as unknown as Context;
    const dispose = await registerSystemPrompt(ctx, services);
    const section = sections[0]!;

    expect(typeof section.text).toBe("function");
    expect(section.interpolate).toBe(false);

    const before = (section.text as () => string)();
    expect(before).toContain("示例画像正文");

    // 改 profile：core.get() 返回含 {{x}} 的用户可控文本
    const core = services.profileStore.core as unknown as { get: () => unknown };
    core.get = () => ({
      display_name: "NewName",
      locale: "zh-CN",
      section_tags: [],
      body: "新正文 {{x}} 原样保留",
      updated_at: "2026-01-02",
      schema_version: 1,
    });
    const after = (section.text as () => string)();

    expect(after).not.toBe(before);
    expect(after).toContain("NewName");
    expect(after).toContain("新正文 {{x}} 原样保留");

    // 真实宿主渲染器：interpolate:false 的 section 保留字面 {{var}}
    const rendered = renderPrompt({
      sections: [{ name: "knowself-l1", text: after, interpolate: false }],
      contexts: [],
      variables: {},
      tools: [],
    });
    expect(rendered).toContain("{{x}}");
    expect(typeof dispose).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 / T04：插件 Config 含 4 个宿主旋钮字段
// ─────────────────────────────────────────────────────────────────────────────
describe("W2/T04：插件 Config 含 4 个宿主旋钮字段", () => {
  it("Schema.object 生成的 dict 含 sourcesDir / personsKeyMode / retrievalTopK / enableMining", () => {
    const fields = Object.keys(Config.dict ?? {});
    expect(fields).toEqual([
      "sourcesDir",
      "personsKeyMode",
      "retrievalTopK",
      "enableMining",
    ]);
    console.log(`[w2-report] Config fields = ${fields.join(",")}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 卡片可发现性：list_cards 与 get_card 的错误提示（2026-11-11 新增）
// ─────────────────────────────────────────────────────────────────────────────

describe("卡片可发现性：无需猜 key", () => {
  const services = makeStubServices()

  it("knowself_list_cards 返回全部卡片摘要（含 key/title）", async () => {
    const tool = makeTools(services).find((t) => t.name === "knowself_list_cards")!
    const result = (await tool.execute({}, undefined as never)) as unknown
    const rows = Array.isArray(result) ? result : ((result as { result?: unknown[] }).result ?? [])
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect((rows[0] as { key?: string }).key).toBe("k1")
  })

  it("get_card 的 key 不存在时，错误信息列出可用 key", async () => {
    const tool = makeTools(services).find((t) => t.name === "knowself_get_card")!
    await expect(tool.execute({ key: "identity" }, undefined as never)).rejects.toThrow(
      /卡片不存在: identity；可用 key: .*k1/,
    )
  })
})
