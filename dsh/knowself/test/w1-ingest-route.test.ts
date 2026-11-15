/**
 * W-1：资料写端点的路由层测试（**只新增，不改既有断言**）。
 *
 * ## 职责
 * 覆盖四工单 W-1 步骤 5 要求的 3 类路由断言，外加去重与通道隔离回归：
 *   A. POST /sources 参数缺失 → 400；摄入层降级 → 503；成功 → 201 + SourceStored
 *   B. POST /sources/:id/distill 未知 id → 404（理由见 `sources-write.ts` 头注：
 *      与 `GET /cards/:key` 的「不存在 → 404」既有约定一致，400 专用于参数错）
 *   C. 同一内容二次提交不新建记录（sha256 去重）
 *   D. **通道隔离**：不带 `/write` 前缀的 POST /sources 仍返回 404 —— 保住
 *      `routes-m3b.test.ts:256-265` 的既有语义，也证明写路由不会污染只读路径
 *
 * ## 为什么用 dispatch 直调而非起 HTTP server
 * `routes/*.ts` 是纯函数式分发，不认识鉴权、不产生 Response；鉴权与 405 守卫在
 * `write-bridge.ts`，其真机行为已由 `evidence/w1-post405-probe.mjs` 单独实测。
 * 这里用 `dispatch(url, services, method, body)` 传 `writeChannel` 语义（由 URL
 * 前缀 `/knowself-api/write` 触发），与真实链路一致但无需 Electron。
 *
 * ## 边界
 * 不开 DB、不触网、不动真实 %APPDATA% 密钥；全部用内存桩，领域调用只记参数。
 */
import { describe, expect, it, vi } from "vitest";
import type { KnowselfServices } from "../src/services.js";
import { dispatch } from "../src/routes/index.js";
import { BadRequestError } from "../src/routes/http.js";

const BASE = "http://localhost";
const WRITE = "/knowself-api/write";

/** 构造一条最小 SourceStored（字段按 contracts 真实形态，用于桩返回）。 */
function makeSource(id: string, text: string) {
  return {
    id,
    kind: "paste" as const,
    original_name: "测试资料",
    mime_type: "text/plain" as const,
    file_path: null,
    url: null,
    extracted_text: text,
    truncated: false,
    char_count: text.length,
    user_note: "",
    user_tags: [],
    status: "raw" as const,
    metadata: {},
    created_at: "2026-11-11T00:00:00.000Z",
    last_ingested_at: null,
    last_error: null,
  };
}

/** 构造内存 services 桩；`withIngestion=false` 模拟第 3 层降级。 */
function makeServices(withIngestion = true, existing: ReturnType<typeof makeSource>[] = []) {
  const createSource = vi.fn(async (_req: unknown, _bytes?: unknown) =>
    makeSource("new-id", "新建文本"),
  );
  const createPasteSource = vi.fn(async (_req: unknown) => makeSource("paste-id", "新建文本"));
  const runDistill = vi.fn(async () => ({
    source_id: "new-id",
    produced_proposal_ids: ["p1"],
    duration_ms: 1,
    token_usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const sources = {
    list: vi.fn(() => ({ items: existing, total: existing.length })),
    get: vi.fn((id: string) => {
      const hit = existing.find((s) => s.id === id);
      if (hit === undefined) throw new Error(`source 不存在: ${id}`);
      return hit;
    }),
  };
  const services = {
    profileStore: { sources },
    sourceIntake: { createPasteSource },
    ...(withIngestion ? { ingestion: { createSource, runDistill } } : {}),
    degraded: {
      missing: withIngestion ? [] : ["ingestion"],
      reasons: withIngestion ? [] : ["检索/摄入层装配失败（阶段=provider）：boom"],
    },
  } as unknown as KnowselfServices;
  return { services, createSource, createPasteSource, runDistill, sources };
}

/** 调写通道的便捷封装。 */
async function post(path: string, services: KnowselfServices, body: unknown) {
  return dispatch(new URL(WRITE + path, BASE), services, "POST", body);
}

describe("W-1 · POST /sources 参数与降级", () => {
  it("参数缺失（无 kind）→ 400 BadRequestError", async () => {
    const { services, createSource } = makeServices();
    await expect(post("/sources", services, { text: "一段中文" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(createSource).not.toHaveBeenCalled();
  });

  it("paste 缺 text → 400，且不落库", async () => {
    const { services, createSource } = makeServices();
    await expect(post("/sources", services, { kind: "paste" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(createSource).not.toHaveBeenCalled();
  });

  it("file 的 content_base64 非法 → 400", async () => {
    const { services } = makeServices();
    await expect(
      post("/sources", services, {
        kind: "file",
        title: "a.txt",
        mime_type: "text/plain",
        content_base64: "!!!not-base64!!!",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("摄入层降级时 paste 仍落库，但不调用模型", async () => {
    const { services, createSource, createPasteSource, runDistill } = makeServices(false);
    const result = await post("/sources", services, { kind: "paste", text: "中文" });
    expect(result.status).toBe(201);
    expect((result.body as { id: string }).id).toBe("paste-id");
    expect(createPasteSource).toHaveBeenCalledTimes(1);
    expect(createSource).not.toHaveBeenCalled();
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("摄入层降级时 file/url 仍返回 503", async () => {
    const { services, createPasteSource } = makeServices(false);

    const file = await post("/sources", services, {
      kind: "file",
      title: "a.txt",
      mime_type: "text/plain",
      content_base64: Buffer.from("text").toString("base64"),
    });
    const url = await post("/sources", services, {
      kind: "url",
      url: "https://example.test/a.txt",
    });

    for (const result of [file, url]) {
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ status: "degraded", layer: "ingestion" });
    }
    expect(createPasteSource).not.toHaveBeenCalled();
  });

  it("成功 → 201 + SourceStored，并触发一次蒸馏（验收 a/b）", async () => {
    const { services, createSource, createPasteSource, runDistill } = makeServices();
    const result = await post("/sources", services, {
      kind: "paste",
      title: "我的资料",
      text: "一段中文测试文本",
    });
    expect(result.status).toBe(201);
    const body = result.body as ReturnType<typeof makeSource>;
    expect(body.kind).toBe("paste");
    expect(body.id).toBe("new-id");
    expect(createSource).toHaveBeenCalledTimes(1);
    const req = createSource.mock.calls[0][0] as Record<string, unknown>;
    expect(req.kind).toBe("paste");
    expect(req.original_name).toBe("我的资料");
    expect(req.text).toBe("一段中文测试文本");
    expect(createPasteSource).not.toHaveBeenCalled();
    expect(runDistill).toHaveBeenCalledTimes(1);
  });
});

describe("W-1 · 去重与重新蒸馏", () => {
  it("同一份内容二次提交 → 200 + 既有 SourceStored，不新建（验收 d）", async () => {
    const text = "重复上传的同一段文本";
    const existing = [makeSource("existing-id", text)];
    const { services, createSource, runDistill } = makeServices(true, existing);
    const result = await post("/sources", services, { kind: "paste", text });
    expect(result.status).toBe(200);
    expect((result.body as { id: string }).id).toBe("existing-id");
    expect(createSource).not.toHaveBeenCalled();
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("POST /sources/:id/distill 未知 id → 404（按 /cards/:key 既有约定）", async () => {
    const { services, runDistill } = makeServices();
    const result = await post("/sources/no-such-id/distill", services, {});
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "not_found" });
    expect(runDistill).not.toHaveBeenCalled();
  });

  it("POST /sources/:id/distill 已知 id → 200 + proposal_count", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services, runDistill } = makeServices(true, existing);
    const result = await post("/sources/s1/distill", services, {});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ source_id: "s1", proposal_count: 1 });
    expect(runDistill).toHaveBeenCalledTimes(1);
  });
});

describe("W-1 · 通道隔离回归（既有断言零回退）", () => {
  it("不带 /write 前缀的 POST /sources → 404，写路由不污染只读路径", async () => {
    const { services, createSource } = makeServices();
    const result = await dispatch(
      new URL("/knowself-api/sources", BASE),
      services,
      "POST",
      { kind: "paste", text: "中文" },
    );
    expect(result).toEqual({ status: 404, body: { error: "not_found" } });
    expect(createSource).not.toHaveBeenCalled();
  });

  it("GET /sources 仍返回数组，行为逐字不变", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services } = makeServices(true, existing);
    const result = await dispatch(new URL("/knowself-api/sources", BASE), services, "GET");
    expect(result.status).toBe(200);
    expect(result.body).toEqual(existing);
  });
});

describe("W-6/E · 蒸馏幂等：force 透传与 reused 回传", () => {
  it("缺省 body → force 透传 undefined，响应体不含 reused（既有字段集合不变）", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services, runDistill } = makeServices(true, existing);

    const result = await post("/sources/s1/distill", services, {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ source_id: "s1", proposal_count: 1 });
    const req = runDistill.mock.calls[0][1] as { force?: boolean };
    expect(req.force).toBe(false);
  });

  it("body { force: true } → 透传 force=true（显式重蒸）", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services, runDistill } = makeServices(true, existing);

    const result = await post("/sources/s1/distill", services, { force: true });

    expect(result.status).toBe(200);
    const req = runDistill.mock.calls[0][1] as { force?: boolean };
    expect(req.force).toBe(true);
  });

  it("领域层 reused=true → 响应体带 reused:true", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services, runDistill } = makeServices(true, existing);
    runDistill.mockResolvedValueOnce({
      source_id: "s1",
      produced_proposal_ids: ["p1", "p2"],
      duration_ms: 0,
      token_usage: { input_tokens: 0, output_tokens: 0 },
      reused: true,
    });

    const result = await post("/sources/s1/distill", services, {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ source_id: "s1", proposal_count: 2, reused: true });
  });

  it("force 非布尔 → 400 BadRequestError，且不调领域层", async () => {
    const existing = [makeSource("s1", "文本")];
    const { services, runDistill } = makeServices(true, existing);

    await expect(
      post("/sources/s1/distill", services, { force: "yes" }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(runDistill).not.toHaveBeenCalled();
  });
});
