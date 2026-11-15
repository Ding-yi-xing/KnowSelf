/**
 * W-6/B：上游错误体脱敏测试。
 *
 * 背景：`chat.ts` 把上游 4xx 体截 300 字塞进 error chunk 的 message，这条
 * message 会经 `distill.ts` 落到 `sources.last_error` 并上屏——属于**用户可见的
 * 落库字段**。若上游在 body 里回显 key（部分网关会），等于把 key 写进数据库。
 *
 * 原则：抹掉凭据，但保留 `model is not found` 这类定位信息（否则又回到
 * 「看不到真实错误」的老问题）。
 *
 * ## 为什么 import `../src` 而不是 `../dist`
 * 根 `package.json` 的 `test` 无预构建、`ci` 用 `tsc -b --emitDeclarationOnly`
 * 不产 JS → 改 src 不 build 就 test 会**假绿**（W-6/D）。
 */
import { describe, it, expect } from "vitest";
import { redactUpstreamText } from "../src/chat";
import { chat } from "../src/chat";
import { createOpenAiAdapter } from "../src/adapter/openai";
import { makeInitialHealth } from "../src/failover";
import type { ChatChunk } from "@knowself/contracts";

const testConfig = {
  id: "test-openai",
  label: "Test",
  protocol: "openai" as const,
  base_url: "https://api.example.com",
  api_key: "sk-real-secret-value-123456",
  model: "test-model",
  purposes: ["chat" as const],
  default_for: [],
  request_timeout_ms: 5000,
  max_retries: 1,
  max_concurrency: 4,
  extra_headers: {} as Record<string, string>,
  declared_supports_tools: true,
  declared_supports_caching: false,
  tags: [],
};

describe("redactUpstreamText", () => {
  it("抹掉 sk- 形式的 key，但保留 model is not found", () => {
    const raw = 'model is not found, your key sk-abcdefgh12345678 is invalid';
    const out = redactUpstreamText(raw);
    expect(out).toContain("model is not found");
    expect(out).not.toContain("sk-abcdefgh12345678");
    expect(out).toContain("***");
  });

  it("抹掉 Bearer 凭据", () => {
    const raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig rejected";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(out).toContain("***");
    expect(out).toContain("rejected");
  });

  it("抹掉 JSON 里的 api_key / authorization / token 字段值", () => {
    const raw =
      '{"api_key":"abc123def456","authorization":"Bearer xyz98765","token":"tok_live_777","message":"model is not found"}';
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain("xyz98765");
    expect(out).not.toContain("tok_live_777");
    // 定位信息必须留下
    expect(out).toContain("model is not found");
  });

  it("无敏感词时原样保留", () => {
    const raw = '{"error":{"type":"not_found_error","message":"model is not found"}}';
    expect(redactUpstreamText(raw)).toBe(raw);
  });
});

/**
 * W-7/A：QA 自建探针给出的 5 个漏网形状（G1~G5）。
 *
 * 这组用例的价值在于**形状**而不是词表：上线后遇到的 key 一定长得和
 * 测试里不一样，所以固定的是「哪一类语法位置」，不是具体字符串。
 */
describe("redactUpstreamText · G1~G5 漏网形状", () => {
  it("G1 大写 SK- 也要抹（大小写不敏感）", () => {
    const raw = "HTTP 401: key SK-REALKEY12345678 rejected";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("SK-REALKEY12345678");
    expect(out).toContain("HTTP 401");
    expect(out).toContain("rejected");
  });

  it("G2 URL query 里的 api_key：保留参数名、只抹值", () => {
    const raw = "https://api.x.com/v1/chat?api_key=abcdefgh12345678&x=1";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("abcdefgh12345678");
    // 精确形状：参数名与后续参数都在，只有值变星号
    expect(out).toBe("https://api.x.com/v1/chat?api_key=***&x=1");
  });

  it("G3 x-api-key 请求头形式", () => {
    const raw = "HTTP 401: x-api-key: abcdefgh12345678";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).toContain("x-api-key: ***");
  });

  it("G4 短 sk-（不足 8 位）也要抹", () => {
    const raw = "HTTP 401: key sk-abc123";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("sk-abc123");
    expect(out).toContain("HTTP 401");
  });

  it("G5 无引号表单 api_key=…&message=bad：只抹值、保留诊断信息", () => {
    const raw = "HTTP 401: api_key=abcdefgh12345678&message=bad";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).toContain("api_key=***");
    // 关键：诊断字段不能被连坐
    expect(out).toContain("message=bad");
  });

  it("URL 里多个敏感参数逐个处理，非敏感参数原样保留", () => {
    const raw = "https://api.x.com/v1?token=tok_live_99999&api_secret=s3cr3tvalue&model=gpt&retry=2";
    const out = redactUpstreamText(raw);
    expect(out).not.toContain("tok_live_99999");
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).toBe("https://api.x.com/v1?token=***&api_secret=***&model=gpt&retry=2");
  });
});

describe("chat() 上游错误体脱敏（集成）", () => {
  it("401 体里的 key 不会出现在 error chunk 的 message 里", async () => {
    const adapter = createOpenAiAdapter(testConfig);
    const health = makeInitialHealth("test-openai", "2026-01-01T00:00:00.000Z");
    const registry = {
      getAdapter: () => adapter,
      getSemaphore: () => ({ acquire: async () => () => {} }),
      getHealth: () => health,
      updateHealth: () => {},
    } as never;

    const body =
      '{"error":{"type":"authentication_error","message":"invalid api key",' +
      '"api_key":"sk-leaked-abcdef123456","hint":"model is not found"}}';
    const fetchImpl = (async () =>
      new Response(body, { status: 401, headers: { "content-type": "application/json" } })) as never;

    const chunks: ChatChunk[] = [];
    for await (const chunk of chat(
      { registry, fetchImpl },
      {
        provider_id: "test-openai",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        tools: [],
        stream: true,
        max_tokens: 16,
        stop_sequences: [],
        metadata: {},
      },
    )) {
      chunks.push(chunk);
    }

    const errorChunk = chunks.find((c) => c.type === "error");
    expect(errorChunk).toBeDefined();
    const message = (errorChunk as { message: string }).message;
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain("sk-leaked-abcdef123456");
    // 关键定位信息不能被一起抹掉
    expect(message).toContain("model is not found");
  });
});

/**
 * W-8/A1：QA 抽查后补的 4 类形状。
 *
 * 断言一律用**精确 `toBe`**（不是 `toContain`）：脱敏最容易犯的错是"抹过头"
 * ——把 `message=bad` 一起吞掉。只有整串比对才逼得出来。
 */
describe("redactUpstreamText · W-8 新增四类", () => {
  it("① JSON 形式的 password / pwd / passwd", () => {
    expect(redactUpstreamText('{"password":"hunter2","message":"bad"}')).toBe(
      '{"password":"***","message":"bad"}',
    );
    expect(redactUpstreamText('{"pwd":"pw123456","message":"bad"}')).toBe(
      '{"pwd":"***","message":"bad"}',
    );
    expect(redactUpstreamText('{"passwd":"topsecret","message":"bad"}')).toBe(
      '{"passwd":"***","message":"bad"}',
    );
  });

  it("① 表单形式的 password / pwd / passwd", () => {
    expect(redactUpstreamText("login password=hunter2&message=bad")).toBe(
      "login password=***&message=bad",
    );
    expect(redactUpstreamText("db passwd=topsecret&next=1")).toBe("db passwd=***&next=1");
    expect(redactUpstreamText("pwd=abcdefgh")).toBe("pwd=***");
  });

  it("② Authorization: Basic <base64>（里面是 user:pass 明文）", () => {
    expect(redactUpstreamText("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: ***",
    );
    // 同一句里的诊断信息必须留
    expect(redactUpstreamText("HTTP 401: Authorization: Basic dXNlcjpwYXNz rejected")).toBe(
      "HTTP 401: Authorization: *** rejected",
    );
  });

  it("③ 裸 key=（没有 ? / & 前缀）", () => {
    expect(redactUpstreamText("HTTP 401: key=abcdefgh1234 rejected")).toBe(
      "HTTP 401: key=*** rejected",
    );
    // 不能切进 api_key= / apikey=（那边由 G2/G5 负责，形状必须保持不变）
    expect(redactUpstreamText("HTTP 401: api_key=abcdefgh12345678&message=bad")).toBe(
      "HTTP 401: api_key=***&message=bad",
    );
  });

  it("④ JSON 键补 refresh_token / secret / camelCase accessToken", () => {
    expect(redactUpstreamText('{"refresh_token":"rt_123456","message":"bad"}')).toBe(
      '{"refresh_token":"***","message":"bad"}',
    );
    expect(redactUpstreamText('{"secret":"s3cr3tvalue","message":"bad"}')).toBe(
      '{"secret":"***","message":"bad"}',
    );
    expect(redactUpstreamText('{"accessToken":"at_123456","message":"bad"}')).toBe(
      '{"accessToken":"***","message":"bad"}',
    );
  });
});

/**
 * W-8/A2：`x-api-key` 空值不得连坐下一段。
 *
 * 旧正则 `x-api-key\s*[:=]\s*[^\s,;}]+` 的第二个 `\s*` 会跨过空值后的空白，
 * 于是 `x-api-key:  message=bad` 里的 `message=bad` 被当成值抹掉——
 * 用户看到的错误信息只剩 `x-api-key: ***`，真正的诊断线索丢了。
 */
describe("redactUpstreamText · x-api-key 空值边界（W-8/A2）", () => {
  it("空值时**一个字符都不消费**（诊断信息必须原样留下）", () => {
    const raw = "HTTP 401: x-api-key:  message=bad";
    expect(redactUpstreamText(raw)).toBe(raw);
    expect(redactUpstreamText(raw)).toContain("message=bad");
  });

  it("有值时仍然只抹紧跟的那一个 token", () => {
    expect(redactUpstreamText("HTTP 401: x-api-key: abcdefgh12345678")).toBe(
      "HTTP 401: x-api-key: ***",
    );
    // 等号写法 + 后面的诊断字段不受影响
    expect(redactUpstreamText("HTTP 401: x-api-key=abcdefgh12345678 message=bad")).toBe(
      "HTTP 401: x-api-key=*** message=bad",
    );
  });
});
