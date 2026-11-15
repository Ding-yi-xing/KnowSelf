import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestWechatAssistPort } from "../src/client/wechat-assist-port.js";

function stubFetch() {
  const fetchStub = vi.fn(async (_input: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }) as unknown as Response);
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("微信协助 REST port", () => {
  it("对同一草稿的发送重试复用幂等键", async () => {
    const fetchStub = stubFetch();
    const port = createRestWechatAssistPort();

    await port.sendDraft("draft-1");
    await port.sendDraft("draft-1");

    const first = fetchStub.mock.calls[0]![1] as RequestInit;
    const second = fetchStub.mock.calls[1]![1] as RequestInit;
    expect((first.headers as Record<string, string>)["x-knowself-idempotency-key"])
      .toBe((second.headers as Record<string, string>)["x-knowself-idempotency-key"]);
  });

  it("为不同动作和草稿生成不同幂等键", async () => {
    const fetchStub = stubFetch();
    const port = createRestWechatAssistPort();

    await port.sendDraft("draft-1");
    await port.discardDraft("draft-1");
    await port.sendDraft("draft-2");

    const keys = fetchStub.mock.calls.map((call) =>
      ((call[1] as RequestInit).headers as Record<string, string>)["x-knowself-idempotency-key"]);
    expect(new Set(keys).size).toBe(3);
  });
});
