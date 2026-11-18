import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createWindowsWechatTransport,
} from "../src/wechat-desktop-transport.js";
import { WechatTransportError } from "../src/wechat-assist-adapter.js";

interface TestRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

class FakeBridgeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;
  requests: TestRequest[] = [];
  onRequest: (request: TestRequest, process: FakeBridgeProcess) => void = () => {};

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const line = chunk.toString().trim();
        if (line !== "") {
          const request = JSON.parse(line) as TestRequest;
          this.requests.push(request);
          this.onRequest(request, this);
        }
        callback();
      },
    });
  }

  respond(request: TestRequest, result: unknown): void {
    this.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  }

  respondError(request: TestRequest, code: string, message: string, outcome?: "not_sent" | "unknown"): void {
    this.stdout.write(JSON.stringify({
      id: request.id,
      ok: false,
      error: { code, message, ...(outcome === undefined ? {} : { outcome }) },
    }) + "\n");
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function capabilities() {
  return {
    available: true,
    can_inspect_conversation: true,
    can_list_unread: true,
    can_send: true,
    can_lookup_send_result: true,
    transport_version: "fake-1",
  };
}

describe("Windows WeChat JSONL transport", () => {
  it("round-trips capability and typed result responses", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (request, bridge) => {
      if (request.method === "probe_capabilities") bridge.respond(request, capabilities());
      if (request.method === "inspect_current_conversation") {
        bridge.respond(request, {
          account_scope: "default",
          conversation_id: "alice",
          kind: "contact",
          visible_name: "Alice",
        });
      }
      if (request.method === "open_conversation") {
        bridge.respond(request, {
          account_scope: "default",
          conversation_id: "alice",
          kind: "contact",
          visible_name: "Alice",
        });
      }
      if (request.method === "list_unread_messages") {
        bridge.respond(request, [{
          message_id: "message-1",
          conversation_id: "alice",
          sender_id: "alice",
          body: "hello",
          received_at: "2026-11-14T12:00:00.000Z",
        }]);
      }
      if (request.method === "probe_idle") {
        // 用户已空闲 2 分钟：静默模式立即放行，不额外等待。
        bridge.respond(request, { idle_seconds: 120 });
      }
      if (request.method === "send_message") {
        bridge.respond(request, { external_id: "external-1", sent_at: "2026-11-14T12:01:00.000Z" });
      }
      if (request.method === "lookup_send_result") {
        bridge.respond(request, { external_id: "external-1" });
      }
    };
    const transport = createWindowsWechatTransport({
      pythonExecutable: "fake-python",
      bridgePath: "fake-bridge.py",
      spawnProcess: () => process,
    });

    await expect(transport.probeCapabilities()).resolves.toMatchObject(capabilities());
    await expect(transport.inspectCurrentConversation()).resolves.toMatchObject({
      conversation_id: "alice",
    });
    await expect(transport.prepareTarget?.("alice")).resolves.toMatchObject({
      conversation_id: "alice",
      visible_name: "Alice",
    });
    await expect(transport.listUnreadMessages("alice")).resolves.toHaveLength(1);
    await expect(transport.sendMessage({
      contact_id: "alice",
      body: "reply",
      idempotency_key: "draft-1",
    })).resolves.toMatchObject({ external_id: "external-1" });
    await expect(transport.lookupSendResult("draft-1")).resolves.toMatchObject({
      external_id: "external-1",
    });
    expect(process.requests.map((request) => request.method)).toEqual([
      "probe_capabilities",
      "inspect_current_conversation",
      "open_conversation",
      "list_unread_messages",
      // 发送前再确认一次「目标会话是否已开着」：这里是 alice，已开着 → 跳过空闲闸门。
      "inspect_current_conversation",
      "send_message",
      "lookup_send_result",
    ]);
    // 静默标记必须随发送请求传给 bridge（bridge 据此走「写输入框 + 后台回车」）。
    const sendRequest = process.requests.find((request) => request.method === "send_message");
    expect(sendRequest?.params).toMatchObject({ contact_id: "alice", body: "reply", quiet: true });
    await transport.stop();
  });

  it("skips the idle probe when quiet send is disabled", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (request, bridge) => {
      if (request.method === "send_message") {
        bridge.respond(request, { external_id: "external-2", sent_at: "2026-11-14T12:01:00.000Z" });
      }
    };
    const transport = createWindowsWechatTransport({
      pythonExecutable: "fake-python",
      bridgePath: "fake-bridge.py",
      quietSend: false,
      spawnProcess: () => process,
    });

    await expect(transport.sendMessage({
      contact_id: "alice",
      body: "reply",
      idempotency_key: "draft-2",
    })).resolves.toMatchObject({ external_id: "external-2" });
    expect(process.requests.map((request) => request.method)).toEqual(["send_message"]);
    expect(process.requests[0]?.params).toMatchObject({ quiet: false });
    await transport.stop();
  });

  it("waits for user idle only when the target chat is not the one already open", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (request, bridge) => {
      if (request.method === "inspect_current_conversation") {
        // 微信停在与目标无关的会话上 → 发送需要切会话，必须走空闲闸门。
        bridge.respond(request, {
          account_scope: "default",
          conversation_id: "bob",
          kind: "contact",
          visible_name: "Bob",
        });
      }
      if (request.method === "probe_idle") {
        bridge.respond(request, { idle_seconds: 120 });
      }
      if (request.method === "send_message") {
        bridge.respond(request, { external_id: "external-3", sent_at: "2026-11-14T12:02:00.000Z" });
      }
    };
    const transport = createWindowsWechatTransport({
      pythonExecutable: "fake-python",
      bridgePath: "fake-bridge.py",
      spawnProcess: () => process,
    });

    await expect(transport.sendMessage({
      contact_id: "alice",
      body: "秒回",
      idempotency_key: "draft-3",
    })).resolves.toMatchObject({ external_id: "external-3" });
    expect(process.requests.map((request) => request.method)).toEqual([
      "inspect_current_conversation",
      "probe_idle",
      "send_message",
    ]);
    await transport.stop();
  });

  it("reads the latest messages of both sides for prompt context", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (request, bridge) => {
      if (request.method === "list_recent_messages") {
        bridge.respond(request, [
          { message_id: "m1", conversation_id: "wechat:alice", sender_id: "me", role: "me", body: "我在楼下", received_at: "2026-11-17T14:30:00", ts_ms: 1 },
          { message_id: "m2", conversation_id: "wechat:alice", sender_id: "alice", role: "them", body: "我也在", received_at: "2026-11-17T14:30:30", ts_ms: 2 },
        ]);
      }
    };
    const transport = createWindowsWechatTransport({
      pythonExecutable: "fake-python",
      bridgePath: "fake-bridge.py",
      spawnProcess: () => process,
    });

    const recent = await transport.listRecentMessages("alice", 20);

    expect(recent).toHaveLength(2);
    expect(recent[1]).toMatchObject({ role: "them", body: "我也在", ts_ms: 2 });
    expect(process.requests[0]?.params).toMatchObject({ contact_id: "alice", limit: 20 });
    await transport.stop();
  });

  it("returns unavailable capabilities when the bridge cannot start", async () => {
    const transport = createWindowsWechatTransport({
      spawnProcess: () => {
        throw new Error("python missing");
      },
    });

    await expect(transport.probeCapabilities()).resolves.toMatchObject({
      available: false,
      can_send: false,
      reason: "unable to start WeChat bridge: python missing",
    });
  });

  it("fails closed when the bridge returns an unsupported operation", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (request, bridge) => {
      bridge.respondError(request, "unsupported", "UIA control contract is not verified", "not_sent");
    };
    const transport = createWindowsWechatTransport({
      quietSend: false,
      spawnProcess: () => process,
    });

    await expect(transport.sendMessage({
      contact_id: "alice",
      body: "reply",
      idempotency_key: "draft-1",
    })).rejects.toMatchObject<Partial<WechatTransportError>>({
      code: "unsupported",
      outcome: "not_sent",
    });
    await transport.stop();
  });

  it("terminates the bridge and reports an unknown outcome on timeout", async () => {
    const process = new FakeBridgeProcess();
    const transport = createWindowsWechatTransport({
      requestTimeoutMs: 10,
      spawnProcess: () => process,
    });

    await expect(transport.lookupSendResult("draft-1")).rejects.toMatchObject<Partial<WechatTransportError>>({
      code: "timeout",
      outcome: "unknown",
    });
    expect(process.killed).toBe(true);
  });

  it("rejects pending work when the bridge exits unexpectedly", async () => {
    const process = new FakeBridgeProcess();
    process.onRequest = (_request, bridge) => {
      bridge.emit("exit", 1, null);
    };
    const transport = createWindowsWechatTransport({
      spawnProcess: () => process,
    });

    await expect(transport.lookupSendResult("draft-1")).rejects.toMatchObject<Partial<WechatTransportError>>({
      code: "unsupported",
      outcome: "unknown",
    });
  });
});
