/**
 * W3/T05 —— 三层分段降级 + rootDir 四级推导的单测（纯桩，不触网、不开 DB）。
 *
 * 用 `assembleServices(rootDir, deps)` 的可注入工厂直接桩化三层装配，
 * 无需 vi.mock 整个领域库模块图；`createRealServices` 仅在本文件被 mock 成抛错，
 * 用于验证 A1-3「核心层失败 → 整体降级」路径不回归（与 test/tools.test.ts 的
 * 既有 A1-3 断言互不干扰，vitest 每个测试文件独立模块图）。
 *
 * 覆盖（工单验收 5 条）：
 *   1. provider 初始化抛错 → 检索/摄入层降级
 *   2. createPersonStore 抛错 → 人物层降级（摄入层仍独立成功）
 *   3. 不设 KNOWSELF_ROOT_DIR → 第③级找到含 settings.json 的仓库根
 *   4. 核心层 createProfileStore 抛错 → 冒泡 + A1-3 整体降级不回归
 *   5. 全层成功 → 16 工具全注册、degraded.missing 为空
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  assembleServices,
  type KnowselfServices,
  type ServiceFactories,
} from "../src/services.js";
import { dispatch } from "../src/routes/index.js";
import { makeTools } from "../src/tools.js";
import { apply, registerAll, resolveRootDir } from "../src/index.js";

// A1-3 验证：把生产入口固定为抛错（本文件专用，不影响其它测试文件）。
vi.mock("../src/services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services.js")>();
  return {
    ...actual,
    createRealServices: vi.fn(async () => {
      throw new Error("A1-3 sim: 核心层装配失败");
    }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 构造纯桩工厂集合；overrides 只覆盖需要制造失败的那一个环节。 */
function makeFactories(overrides: Partial<ServiceFactories> = {}): ServiceFactories {
  const profileStore = {
    core: { get: () => ({}) },
    cards: { list: () => [] },
    journal: { get: () => ({ date: "", records: [] }) },
    proposals: { listByStatus: () => [] },
    sources: { list: () => ({ items: [], total: 0 }) },
    write: () => {},
  };
  const personStore = {
    listPersons: () => [],
    getPerson: () => null,
    events: { timeline: () => [] },
    openReplyRetrievalDb: () => ({} as never),
  };
  const contextRouter = {
    buildContext: async () => ({ messages: [], metadata: {} }),
  };
  const ingestion = {
    createSource: async () => ({ id: "s1", status: "pending" }),
    runDistill: async () => ({ proposals: [] }),
    listProposalsByStatus: () => [],
    acceptProposal: () => ({}),
    editProposal: () => ({}),
    rejectProposal: () => ({}),
  };
  const base = {
    loadSettings: () => ({
      providers: [{ id: "p", purposes: ["distill"] }],
      retrieval: {},
      mcp_servers: [],
    }),
    getDataPaths: (rootDir: string) => ({
      rootDir,
      dataDir: "",
      profileDbPath: "",
      sourcesDir: "",
      exportsDir: "",
      modelsDir: "",
      conversationsDbPath: "",
      retrievalDbPath: "",
      personsDbPath: "",
      automationDir: "",
      automationDbPath: "",
    }),
    ensureDataDirs: () => {},
    createProfileStore: () => profileStore,
    createSourceIntake: () => ({
      createPasteSource: async () => ({ id: "paste-1", status: "raw" }),
    }),
    // MD2-4：默认桩返回「已存在文件」，隔离真实 %APPDATA%（绝不读写真实密钥）。
    ensurePersonsKey: () => ({
      path: "/tmp/w3/persons.key",
      created: false,
      source: "file",
    }),
    createPersonStore: () => personStore,
    createMcpHost: async () => ({
      init: async () => {},
      getToolRegistry: () => ({}),
    }),
    createProviderAdapter: () => ({ init: async () => {} }),
    createContextRouter: () => contextRouter,
    createIngestion: () => ingestion,
    chatIngest: {
      createChatMessageCommitter: () => ({
        commit: () => ({ committed: 0, skipped: 0 }),
      }),
      createChatMessageRejecter: () => ({ reject: () => ({ rejected: 0 }) }),
      ingestExport: async () => ({ imported: 0, warnings: [] }),
    },
  } as unknown as ServiceFactories;
  return { ...base, ...overrides };
}

interface Harness {
  ctx: Context;
  registeredNames: () => string[];
  errorArgs: () => unknown[][];
  webRoutes: () => number;
  /** §13.4：桥仍注册，捕获其 resource 以直接断言 503 响应体。 */
  resource: () => ((request: Request) => Promise<Response>) | undefined;
}

/** 桩 ctx：捕获注册的工具、logger.error 参数、REST 路由与 resource。 */
function makeCtx(): Harness {
  const registered: Array<{ name: string }> = [];
  const errors: unknown[][] = [];
  let routes = 0;
  let resource: ((request: Request) => Promise<Response>) | undefined;
  const ctxObj = {
    tools: {
      register: (def: { name: string }) => {
        registered.push(def);
        return () => {};
      },
    },
    systemPrompt: { section: () => () => {} },
    settings: { configure: () => () => {} },
    logger: () => ({
      error: (...args: unknown[]) => {
        errors.push(args);
      },
      warn: () => {},
      info: () => {},
    }),
    // 桩 inject：webServer + connection 就绪 → 执行 cb、注册路由（复刻 W2 的桩语义）。
    inject: (_deps: string[], cb: (sub: unknown) => void) => {
      const sub = {
        webServer: {
          // W-1：`registerAll` 会注册两条路由 —— resource 型只读桥 +
          // handler 型写桥。只有 resource 型带 `resource` 字段，handler 型带
          // `handler`；这里按字段分流，**不覆盖**已捕获的只读 resource，
          // 否则场景 2 的 `h.resource()` 会变成 undefined（回归保护）。
          register: (route: {
            resource?: (request: Request) => Promise<Response>;
            handler?: (...args: unknown[]) => unknown;
          }) => {
            routes += 1;
            if (route.resource !== undefined) resource = route.resource;
            return () => {};
          },
        },
        // F3：dsh `connection` 鉴权入口桩——本节验证「已认证 + 降级 → 503」。
        connection: { requestRejection: (_request: Request) => undefined },
        effect: (fn: () => unknown) => fn(),
        logger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
      };
      cb(sub);
      return { dispose: async () => {} };
    },
  };
  return {
    ctx: ctxObj as unknown as Context,
    registeredNames: () => registered.map((d) => d.name),
    errorArgs: () => errors,
    webRoutes: () => routes,
    resource: () => resource,
  };
}

describe("W3/T05：三层分段降级", () => {
  it("场景1：provider 初始化抛错 → 检索/摄入层降级，只注册核心+人物+intent 工具", async () => {
    const factories = makeFactories({
      createProviderAdapter: () => ({
        init: async () => {
          throw new Error("provider init boom");
        },
      }),
    });
    const services = await assembleServices("/tmp/w3", factories);

    expect(services.degraded?.missing).toContain("retrieval");
    expect(services.degraded?.missing).toContain("ingestion");
    expect(services.degraded?.missing).not.toContain("person");
    expect(services.degraded?.reasons.join(" ")).toContain("provider init boom");
    expect(services.personStore).toBeDefined();
    expect(services.sourceIntake).toBeDefined();

    // Inbox 读取是 profileStore 核心能力，不依赖 Provider/MCP 或 ingestion 实例。
    await expect(
      dispatch(new URL("http://localhost/knowself-api/proposals"), services),
    ).resolves.toEqual({ status: 200, body: [] });

    const h = makeCtx();
    await registerAll(h.ctx, services);
    const names = h.registeredNames();
    console.log(
      `[w3-report] 场景1 注册数=${names.length} 工具=${names.join(",")}`,
    );
    expect(names).toHaveLength(11);
    for (const name of [
      "knowself_search",
      "knowself_ingest",
      "knowself_import_chat",
      "knowself_list_proposals",
      "knowself_decide_proposal",
    ]) {
      expect(names).not.toContain(name);
    }
    for (const name of [
      "knowself_get_profile",
      "knowself_get_card",
      "knowself_get_journal",
      "knowself_append_journal",
      "knowself_intent",
    ]) {
      expect(names).toContain(name);
    }
    // 降级可观测：logger.error 收到缺失层与原始原因
    expect(h.errorArgs().length).toBeGreaterThan(0);
    const logged = JSON.stringify(h.errorArgs());
    expect(logged).toContain("retrieval");
    expect(logged).toContain("provider init boom");
    // 人物层成功 → REST 桥仍注册。
    // W-1：读桥（resource 型）+ 写桥（handler 型）各一条，共 2 条；
    // 原 `toBe(1)` 描述的是 W-1 之前的事实，这里做**语义保真迁移**，
    // 断言「两条都注册」而不是把数量放宽成 >=1（不弱化）。
    expect(h.webRoutes()).toBe(2);
  });

  it("provider 初始化失败时 paste 仍走核心 SourceIntake，file 保持 ingestion 503", async () => {
    const createPasteSource = vi.fn(async () => ({ id: "paste-1", status: "raw" }));
    const factories = makeFactories({
      createProviderAdapter: () => ({
        init: async () => {
          throw new Error("provider init boom");
        },
      }),
      createSourceIntake: (() => ({ createPasteSource })) as ServiceFactories["createSourceIntake"],
    });
    const services = await assembleServices("/tmp/w3", factories);

    const paste = await dispatch(
      new URL("http://localhost/knowself-api/write/sources"),
      services,
      "POST",
      { kind: "paste", text: "离线资料" },
    );
    const file = await dispatch(
      new URL("http://localhost/knowself-api/write/sources"),
      services,
      "POST",
      {
        kind: "file",
        title: "a.txt",
        mime_type: "text/plain",
        content_base64: Buffer.from("text").toString("base64"),
      },
    );

    expect(paste).toEqual({ status: 201, body: { id: "paste-1", status: "raw" } });
    expect(createPasteSource).toHaveBeenCalledTimes(1);
    expect(file.status).toBe(503);
    expect(file.body).toMatchObject({ status: "degraded", layer: "ingestion" });
  });

  it("Router 初始化失败时仍保留 ingestion", async () => {
    const factories = makeFactories({
      createContextRouter: () => {
        throw new Error("router init boom");
      },
    });
    const services = await assembleServices("/tmp/w3", factories);

    expect(services.contextRouter).toBeUndefined();
    expect(services.ingestion).toBeDefined();
    expect(services.degraded?.missing).toEqual(["retrieval"]);
    expect(services.degraded?.reasons.join(" ")).toContain("router init boom");
  });

  it("ingestion 初始化失败时仍保留 Router", async () => {
    const factories = makeFactories({
      createIngestion: () => {
        throw new Error("ingestion init boom");
      },
    });
    const services = await assembleServices("/tmp/w3", factories);

    expect(services.contextRouter).toBeDefined();
    expect(services.ingestion).toBeUndefined();
    expect(services.degraded?.missing).toEqual(["ingestion"]);
    expect(services.degraded?.reasons.join(" ")).toContain("ingestion init boom");
  });

  it("场景2：createPersonStore 抛错 → 人物层降级，REST 桥仍注册且三端点 503，摄入层仍独立成功", async () => {
    const factories = makeFactories({
      createPersonStore: () => {
        throw new Error("person store boom");
      },
    });
    const services = await assembleServices("/tmp/w3", factories);

    expect(services.degraded?.missing).toContain("person");
    expect(services.degraded?.reasons.join(" ")).toContain("person store boom");
    expect(services.personStore).toBeUndefined();
    // 关键（packages/ingestion/src/index.ts:46,52）：committer/rejecter 可选，
    // 人物层失败时省略二者，摄入层不连累降级。
    expect(services.ingestion).toBeDefined();
    expect(services.degraded?.missing).not.toContain("ingestion");
    expect(services.degraded?.missing).not.toContain("retrieval");

    const h = makeCtx();
    await registerAll(h.ctx, services);
    const names = h.registeredNames();
    console.log(
      `[w3-report] 场景2 注册数=${names.length} 工具=${names.join(",")}`,
    );
    expect(names).toHaveLength(10);
    for (const name of [
      "knowself_list_persons",
      "knowself_get_person",
      "knowself_person_events",
      "knowself_metrics",
      "knowself_network",
      "knowself_import_chat",
    ]) {
      expect(names).not.toContain(name);
    }
    for (const name of [
      "knowself_get_profile",
      "knowself_search",
      "knowself_ingest",
      "knowself_list_proposals",
      "knowself_decide_proposal",
    ]) {
      expect(names).toContain(name);
    }

    // §13.4 迁移：旧断言「REST 桥不注册（webRoutes=0）」→
    // 「桥仍注册 + 三端点 503 + 约定响应体 + 脱敏 + 未知路径仍 404」。
    // W-1：数量由 1 → 2（读桥 + 写桥），见本文件 makeCtx 的分流注释。
    expect(h.webRoutes()).toBe(2);
    const resource = h.resource();
    expect(resource).toBeDefined();
    for (const path of ["/persons", "/person/p1", "/person/p1/timeline"]) {
      const res = await resource!(new Request(`http://x/knowself-api${path}`));
      expect(res.status, path).toBe(503);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as {
        status: string;
        layer: string;
        reason: string;
      };
      expect(body.status).toBe("degraded");
      expect(body.layer).toBe("person");
      expect(typeof body.reason).toBe("string");
      expect(body.reason).toContain("person store boom");
      // 脱敏：不含绝对路径 / 堆栈痕迹
      expect(body.reason).not.toContain("C:\\");
      expect(body.reason).not.toContain("    at ");
    }
    const notFound = await resource!(
      new Request("http://x/knowself-api/unknown"),
    );
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toEqual({ error: "not_found" });
  });

  it("场景3：不设 KNOWSELF_ROOT_DIR → 第③级从 import.meta.url 找到含 settings.json 的仓库根", () => {
    // vitest 1.6 的 `stubEnv(name, undefined)` 会写入字符串 "undefined" 而非删除，
    // 因此这里直接 delete 并在 finally 恢复，真实模拟「环境变量未设置」。
    const previous = process.env.KNOWSELF_ROOT_DIR;
    delete process.env.KNOWSELF_ROOT_DIR;
    try {
      const root = resolveRootDir();
      console.log(`[w3-report] resolveRootDir() = ${root}`);
      expect(root.replace(/\\/g, "/")).toMatch(/AllProjecks\/knowSelf$/i);
      expect(existsSync(join(root, "settings.json"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KNOWSELF_ROOT_DIR;
      else process.env.KNOWSELF_ROOT_DIR = previous;
    }
  });

  it("场景4：核心层 createProfileStore 抛错 → 冒泡；apply 的 A1-3 整体降级不回归", async () => {
    const factories = makeFactories({
      createProfileStore: () => {
        throw new Error("core profile boom");
      },
    });
    await expect(assembleServices("/tmp/w3", factories)).rejects.toThrow(
      "core profile boom",
    );

    // createRealServices 已被本文件 vi.mock 设为抛错 → apply 走 A1-3。
    const root = new Context();
    const registered: unknown[] = [];
    root.provide("tools", {
      register: (def: unknown) => {
        registered.push(def);
        return () => {};
      },
    });
    root.provide("systemPrompt", { section: () => () => {} });
    root.provide("settings", { configure: () => () => {} });
    await root.plugin(apply);
    expect(registered).toHaveLength(0);
  });

  it("场景5：全层成功 → 16 个工具全注册、degraded.missing 为空、REST 桥注册", async () => {
    const services = await assembleServices("/tmp/w3", makeFactories());
    expect(services.degraded?.missing).toEqual([]);
    expect(services.degraded?.reasons).toEqual([]);

    const h = makeCtx();
    await registerAll(h.ctx, services);
    const names = h.registeredNames();
    console.log(
      `[w3-report] 场景5 注册数=${names.length} 工具=${names.join(",")}`,
    );
    expect(names).toHaveLength(16);
    // W-1：全层成功时读桥 + 写桥都注册（2 条），见 makeCtx 分流注释。
    expect(h.webRoutes()).toBe(2);
    expect(h.errorArgs()).toHaveLength(0);
    // makeTools 直接调用（既有调用方）行为不回退
    expect(makeTools(services)).toHaveLength(16);
  });
});

describe("W3/T05：既有测试桩（无 degraded 字段）行为不回退", () => {
  it("degraded 缺失时 makeTools 视为全层可用，仍返回 16 个工具", () => {
    const stub = {
      profileStore: {},
      personStore: {},
      contextRouter: {},
      ingestion: {},
      chatIngest: {},
      settings: {},
    } as unknown as KnowselfServices;
    expect(makeTools(stub)).toHaveLength(16);
  });
});
