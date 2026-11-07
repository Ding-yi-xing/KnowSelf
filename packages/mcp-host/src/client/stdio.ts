import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ToolDescriptor,
  ToolResult,
  ToolBareName,
  ToolSourceId,
  McpStdioConfig,
} from "@knowself/contracts";
import type { IMcpClient, ToolDescriptorInput } from "./types";
import { StartupTimeoutError, RpcTimeoutError, SpawnFailedError } from "../errors";
import { toFullName } from "../namespace";
import { randomUUID } from "node:crypto";

export async function createStdioClient(
  config: McpStdioConfig,
  opts: {
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    sourceId: ToolSourceId;
  },
): Promise<IMcpClient> {
  const { sourceId, startupTimeoutMs, requestTimeoutMs } = opts;

  const proc = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    cwd: config.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "RPC error"));
        else p.resolve(msg.result);
      }
    } catch {
      /* ignore non-JSON lines */
    }
  });

  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf-8");
  });

  proc.on("error", () => {
    for (const [, p] of pending) p.reject(new SpawnFailedError(sourceId));
  });

  function rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(new RpcTimeoutError(sourceId));
          }, timeoutMs)
        : null;
      pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, id, params }) + "\n");
    });
  }

  // Initialize handshake
  try {
    const initResult = (await rpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "knowself-mcp-host", version: "0.0.0" },
      },
      startupTimeoutMs,
    )) as Record<string, unknown>;

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );

    const serverInfo = initResult.serverInfo as Record<string, unknown> | undefined;
    const serverName = (serverInfo?.name as string) ?? sourceId;

    return {
      sourceId,

      async listTools(): Promise<ToolDescriptor[]> {
        const result = (await rpc("tools/list", undefined, requestTimeoutMs)) as {
          tools: ToolDescriptorInput[];
        };
        const now = new Date().toISOString();
        return (result.tools ?? []).map((t) => ({
          name: toFullName(sourceId, t.name),
          source_id: sourceId,
          bare_name: t.name,
          description: t.description ?? `${serverName} tool: ${t.name}`,
          input_schema: t.input_schema ?? {},
          tags: [],
          declared_dangerous: false,
          timeout_ms: requestTimeoutMs,
          created_at: now,
        }));
      },

      async invoke(
        bareName: ToolBareName,
        input: unknown,
        signal?: AbortSignal,
      ): Promise<ToolResult> {
        const startedAt = new Date().toISOString();
        try {
          const output = await new Promise<unknown>((resolve, reject) => {
            const abortHandler = () => reject(new Error("ABORTED"));
            if (signal?.aborted) reject(new Error("ABORTED"));
            signal?.addEventListener("abort", abortHandler, { once: true });
            rpc("tools/call", { name: bareName, arguments: input }, requestTimeoutMs).then(
              (v) => {
                signal?.removeEventListener("abort", abortHandler);
                resolve(v);
              },
              (e) => {
                signal?.removeEventListener("abort", abortHandler);
                reject(e);
              },
            );
          });

          const finishedAt = new Date().toISOString();
          const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

          return {
            tool_use_id: randomUUID(),
            name: toFullName(sourceId, bareName),
            is_error: false,
            output: JSON.stringify(output),
            error_code: null,
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: durationMs,
            source_id: sourceId,
          } satisfies ToolResult;
        } catch (err) {
          const finishedAt = new Date().toISOString();
          const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
          return {
            tool_use_id: randomUUID(),
            name: toFullName(sourceId, bareName),
            is_error: true,
            output: err instanceof Error ? err.message : String(err),
            error_code: err instanceof RpcTimeoutError ? "TIMEOUT" : "UPSTREAM_ERROR",
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: durationMs,
            source_id: sourceId,
          } satisfies ToolResult;
        }
      },

      async dispose(): Promise<void> {
        rl.close();
        if (proc.exitCode === null) {
          proc.kill("SIGTERM");
          const killed = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => {
              proc.kill("SIGKILL");
              resolve(true);
            }, 5000);
            proc.on("close", () => {
              clearTimeout(t);
              resolve(true);
            });
          });
          void killed;
        }
      },
    };
  } catch (err) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    if (err instanceof RpcTimeoutError) {
      throw new StartupTimeoutError(sourceId);
    }
    throw new SpawnFailedError(
      sourceId,
      undefined,
      stderr.slice(0, 256) || (err instanceof Error ? err.message : String(err)),
    );
  }
}
