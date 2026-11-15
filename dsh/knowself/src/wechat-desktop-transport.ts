import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  WechatConversationIdentity,
  WechatDesktopCapabilities,
  WechatDesktopTransport,
  WechatSendLookupResult,
  WechatSendResult,
  WechatUnreadMessage,
} from "./wechat-assist-adapter.js";
import { WechatTransportError } from "./wechat-assist-adapter.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 500;
const MAX_LINE_LENGTH = 1_048_576;

type BridgeMethod =
  | "probe_capabilities"
  | "inspect_current_conversation"
  | "list_unread_messages"
  | "send_message"
  | "lookup_send_result";

interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

interface BridgeErrorPayload {
  code: string;
  message: string;
  outcome?: "not_sent" | "unknown";
}

interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeErrorPayload;
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

interface SpawnedBridge {
  stdin: ChildProcessWithoutNullStreams["stdin"];
  stdout: ChildProcessWithoutNullStreams["stdout"];
  stderr: ChildProcessWithoutNullStreams["stderr"];
  once(event: "error" | "exit", listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  killed: boolean;
}

export interface WindowsWechatTransportOptions {
  pythonExecutable?: string;
  pythonArgs?: string[];
  bridgePath?: string;
  requestTimeoutMs?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => SpawnedBridge;
}

function defaultBridgePath(): string {
  return fileURLToPath(new URL("./wechat-uia-bridge.py", import.meta.url));
}

function unavailableCapabilities(reason: string): WechatDesktopCapabilities {
  return {
    available: false,
    can_inspect_conversation: false,
    can_list_unread: false,
    can_send: false,
    can_lookup_send_result: false,
    transport_version: "windows-uia-jsonl/0.1",
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function parseCapabilities(value: unknown): WechatDesktopCapabilities {
  const record = requireRecord(value, "capabilities");
  const booleanField = (key: string): boolean => {
    if (typeof record[key] !== "boolean") throw new Error(`capabilities.${key} must be a boolean`);
    return record[key] as boolean;
  };
  const reason = record.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error("capabilities.reason must be a string when present");
  }
  return {
    available: booleanField("available"),
    can_inspect_conversation: booleanField("can_inspect_conversation"),
    can_list_unread: booleanField("can_list_unread"),
    can_send: booleanField("can_send"),
    can_lookup_send_result: booleanField("can_lookup_send_result"),
    transport_version: requireString(record, "transport_version", "capabilities"),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseConversation(value: unknown): WechatConversationIdentity | null {
  if (value === null) return null;
  const record = requireRecord(value, "conversation");
  const kind = record.kind;
  if (kind !== "contact" && kind !== "group") throw new Error("conversation.kind is invalid");
  return {
    account_scope: requireString(record, "account_scope", "conversation"),
    conversation_id: requireString(record, "conversation_id", "conversation"),
    kind,
    visible_name: requireString(record, "visible_name", "conversation"),
  };
}

function parseUnreadMessages(value: unknown): WechatUnreadMessage[] {
  if (!Array.isArray(value)) throw new Error("unread_messages must be an array");
  return value.map((item, index) => {
    const record = requireRecord(item, `unread_messages[${index}]`);
    return {
      message_id: requireString(record, "message_id", `unread_messages[${index}]`),
      conversation_id: requireString(record, "conversation_id", `unread_messages[${index}]`),
      sender_id: requireString(record, "sender_id", `unread_messages[${index}]`),
      body: requireString(record, "body", `unread_messages[${index}]`),
      received_at: requireString(record, "received_at", `unread_messages[${index}]`),
    };
  });
}

function parseSendResult(value: unknown): WechatSendResult {
  const record = requireRecord(value, "send_result");
  const externalId = record.external_id;
  const sentAt = record.sent_at;
  if (externalId !== undefined && typeof externalId !== "string") {
    throw new Error("send_result.external_id must be a string when present");
  }
  if (sentAt !== undefined && typeof sentAt !== "string") {
    throw new Error("send_result.sent_at must be a string when present");
  }
  return {
    ...(externalId === undefined ? {} : { external_id: externalId }),
    ...(sentAt === undefined ? {} : { sent_at: sentAt }),
  };
}

function parseLookupResult(value: unknown): WechatSendLookupResult | null {
  if (value === null) return null;
  const record = requireRecord(value, "send_lookup");
  const externalId = requireString(record, "external_id", "send_lookup");
  const sentAt = record.sent_at;
  if (sentAt !== undefined && typeof sentAt !== "string") {
    throw new Error("send_lookup.sent_at must be a string when present");
  }
  return {
    external_id: externalId,
    ...(sentAt === undefined ? {} : { sent_at: sentAt }),
  };
}

function transportErrorFromBridge(error: BridgeErrorPayload): WechatTransportError {
  const knownCodes = new Set<WechatTransportError["code"]>([
    "unsupported",
    "target_mismatch",
    "permission_denied",
    "timeout",
    "window_changed",
    "send_failed",
  ]);
  const code = knownCodes.has(error.code as WechatTransportError["code"])
    ? (error.code as WechatTransportError["code"])
    : "send_failed";
  return new WechatTransportError(error.message, code, error.outcome ?? "unknown");
}

export function createWindowsWechatTransport(
  options: WindowsWechatTransportOptions = {},
): WechatDesktopTransport {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    defaultSpawn(command, args, spawnOptions) as SpawnedBridge);
  const pythonExecutable = options.pythonExecutable ?? process.env.KNOWSELF_WECHAT_PYTHON ?? "py";
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const pythonArgs = options.pythonArgs ?? (
    pythonExecutable === "py" || pythonExecutable.toLowerCase().endsWith("\\py.exe")
      ? ["-3", bridgePath]
      : [bridgePath]
  );

  let child: SpawnedBridge | undefined;
  let lineBuffer = "";
  let requestSequence = 0;
  let stopping = false;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: unknown): void => {
    for (const [requestId, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(requestId);
    }
  };

  const terminateChild = (): void => {
    if (child !== undefined && !child.killed) child.kill();
    child = undefined;
    lineBuffer = "";
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const error = new WechatTransportError("WeChat bridge returned invalid JSON", "send_failed");
      rejectPending(error);
      terminateChild();
      return;
    }
    const response = requireRecord(parsed, "bridge response") as unknown as BridgeResponse;
    if (typeof response.id !== "string" || typeof response.ok !== "boolean") {
      const error = new WechatTransportError("WeChat bridge returned an invalid response", "send_failed");
      rejectPending(error);
      terminateChild();
      return;
    }
    const request = pending.get(response.id);
    if (request === undefined) return;
    clearTimeout(request.timer);
    pending.delete(response.id);
    if (response.ok) {
      request.resolve(response.result);
      return;
    }
    const errorPayload = isRecord(response.error) ? response.error : undefined;
    request.reject(
      errorPayload === undefined
        ? new WechatTransportError("WeChat bridge returned an unknown error", "send_failed")
        : transportErrorFromBridge({
            code: typeof errorPayload.code === "string" ? errorPayload.code : "send_failed",
            message: typeof errorPayload.message === "string" ? errorPayload.message : "bridge error",
            ...(errorPayload.outcome === "not_sent" || errorPayload.outcome === "unknown"
              ? { outcome: errorPayload.outcome }
              : {}),
          }),
    );
  };

  const ensureChild = (): SpawnedBridge => {
    if (child !== undefined) return child;
    stopping = false;
    let nextChild: SpawnedBridge;
    try {
      nextChild = spawnProcess(pythonExecutable, pythonArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new WechatTransportError(
        `unable to start WeChat bridge: ${error instanceof Error ? error.message : String(error)}`,
        "unsupported",
        "not_sent",
      );
    }
    child = nextChild;
    nextChild.stdout.setEncoding("utf8");
    nextChild.stdout.on("data", (chunk: string | Buffer) => {
      lineBuffer += chunk.toString();
      if (lineBuffer.length > MAX_LINE_LENGTH) {
        const error = new WechatTransportError("WeChat bridge response exceeded the size limit", "send_failed");
        rejectPending(error);
        terminateChild();
        return;
      }
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line !== "") handleLine(line);
        newlineIndex = lineBuffer.indexOf("\n");
      }
    });
    nextChild.stderr.setEncoding("utf8");
    nextChild.stderr.on("data", () => {
      // stderr is diagnostic only; protocol failures are reported through stdout/exit.
    });
    nextChild.once("error", (error: unknown) => {
      child = undefined;
      lineBuffer = "";
      rejectPending(new WechatTransportError(
        `unable to start WeChat bridge: ${error instanceof Error ? error.message : String(error)}`,
        "unsupported",
        "not_sent",
      ));
    });
    nextChild.once("exit", (_code: unknown, _signal: unknown) => {
      const error = new WechatTransportError(
        stopping ? "WeChat bridge stopped" : "WeChat bridge exited unexpectedly",
        "unsupported",
        stopping ? "not_sent" : "unknown",
      );
      child = undefined;
      lineBuffer = "";
      if (!stopping) rejectPending(error);
    });
    return nextChild;
  };

  const request = async (method: BridgeMethod, params: Record<string, unknown>): Promise<unknown> => {
    const processHandle = ensureChild();
    const id = `wechat-${++requestSequence}`;
    const message: BridgeRequest = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        terminateChild();
        reject(new WechatTransportError(`WeChat bridge request timed out: ${method}`, "timeout"));
      }, requestTimeoutMs);
      pending.set(id, { timer, resolve, reject });
      try {
        processHandle.stdin.write(JSON.stringify(message) + "\n");
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new WechatTransportError(
          `unable to write WeChat bridge request: ${error instanceof Error ? error.message : String(error)}`,
          "unsupported",
          "not_sent",
        ));
      }
    });
  };

  return {
    async probeCapabilities() {
      try {
        return parseCapabilities(await request("probe_capabilities", {}));
      } catch (error) {
        return unavailableCapabilities(error instanceof Error ? error.message : String(error));
      }
    },
    async inspectCurrentConversation() {
      return parseConversation(await request("inspect_current_conversation", {}));
    },
    async listUnreadMessages() {
      return parseUnreadMessages(await request("list_unread_messages", {}));
    },
    async sendMessage(input) {
      if (input.contact_id.trim() === "" || input.body.trim() === "" || input.idempotency_key.trim() === "") {
        throw new WechatTransportError("WeChat send input is incomplete", "send_failed", "not_sent");
      }
      return parseSendResult(await request("send_message", input));
    },
    async lookupSendResult(idempotencyKey) {
      if (idempotencyKey.trim() === "") {
        throw new WechatTransportError("idempotency key is required", "send_failed", "not_sent");
      }
      return parseLookupResult(await request("lookup_send_result", { idempotency_key: idempotencyKey }));
    },
    async stop() {
      if (child === undefined) return;
      stopping = true;
      rejectPending(new WechatTransportError("WeChat bridge stopped", "unsupported", "not_sent"));
      const processHandle = child;
      processHandle.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!processHandle.killed) processHandle.kill();
          resolve();
        }, STOP_TIMEOUT_MS);
        processHandle.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      child = undefined;
      lineBuffer = "";
    },
  };
}
