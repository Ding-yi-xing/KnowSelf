import type { ProviderConfig, ChatOptions, ChatChunk, ProviderMessage } from "@knowself/contracts";
import type { IAdapter } from "./types";
import type { SseEvent } from "../stream";

export function createAnthropicAdapter(config: ProviderConfig): IAdapter {
  return {
    protocol: "anthropic",

    encodeRequest(opts: ChatOptions): { url: string; init: RequestInit } {
      const msgs = opts.messages as ProviderMessage[];

      const systemBlocks = msgs
        .filter((m) => m.role === "system")
        .map((m) => {
          const block = m.content.find((b) => b.kind === "text");
          return block?.kind === "text" ? { type: "text" as const, text: block.text } : null;
        })
        .filter((b): b is NonNullable<typeof b> => b !== null);

      const messages = msgs.filter((m) => m.role !== "system").map(convertMessage);

      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: opts.max_tokens,
        messages,
        stream: opts.stream,
      };
      if (systemBlocks.length > 0) body.system = systemBlocks;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.top_p !== undefined) body.top_p = opts.top_p;
      if (opts.stop_sequences?.length) body.stop_sequences = opts.stop_sequences;
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        }));
      }
      if (opts.thinking?.enabled) {
        body.thinking = { type: "enabled", budget_tokens: opts.thinking.budget_tokens ?? 4096 };
      }

      return {
        url: `${config.base_url}/messages`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 官方 Anthropic 认 x-api-key；anthropic 协议的聚合平台（商汤 token.sensenova.cn、
            // 小米等）改用 OpenAI 风格的 Authorization: Bearer。两个头同时发以兼容两类后端：
            // 官方会优先用 x-api-key 并忽略多余的 Authorization，聚合平台只看 Bearer。
            "x-api-key": config.api_key,
            Authorization: `Bearer ${config.api_key}`,
            ...(config.extra_headers?.["anthropic-version"]
              ? { "anthropic-version": String(config.extra_headers["anthropic-version"]) }
              : { "anthropic-version": "2023-06-01" }),
            ...config.extra_headers,
          },
          body: JSON.stringify(body),
        },
      };
    },

    async *decodeStream(events: AsyncIterable<SseEvent>): AsyncIterable<ChatChunk> {
      interface PendingTool {
        id: string;
        name: string;
        input: string;
      }
      const tools: Map<number, PendingTool> = new Map();

      for await (const evt of events) {
        if (!evt.data) continue;
        const eventType = evt.event ?? "unknown";

        try {
          const obj = JSON.parse(evt.data);

          if (eventType === "content_block_start") {
            const block = obj.content_block ?? obj;
            if (block.type === "tool_use") {
              tools.set(obj.index, {
                id: block.id ?? `toolu_${obj.index}`,
                name: block.name ?? "",
                input: "",
              });
            }
          } else if (eventType === "content_block_delta") {
            const delta = obj.delta ?? obj;
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "text", delta: delta.text } satisfies ChatChunk;
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const t = tools.get(obj.index);
              if (t) t.input += delta.partial_json;
            }
          } else if (eventType === "content_block_stop") {
            for (const [_idx, t] of tools) {
              let input: unknown = {};
              try {
                input = JSON.parse(t.input);
              } catch {
                input = t.input;
              }
              yield {
                type: "tool_use",
                tool_use_id: t.id,
                name: t.name,
                input,
              } satisfies ChatChunk;
            }
            tools.clear();
          } else if (eventType === "message_delta") {
            const delta = obj.delta ?? obj;
            yield {
              type: "message_end",
              stop_reason: mapStopReason(delta.stop_reason ?? "end_turn"),
            } satisfies ChatChunk;
          } else if (eventType === "message_stop") {
            // stream end — nothing extra to yield
          } else if (eventType === "error") {
            yield {
              type: "error",
              upstream_status: obj.error?.status_code ?? null,
              message: obj.error?.message ?? "Anthropic error",
              retryable: obj.error?.type === "overloaded_error",
            } satisfies ChatChunk;
          }
        } catch {
          // skip
        }
      }
    },
  };
}

function convertMessage(msg: ProviderMessage): Record<string, unknown> {
  const content = msg.content
    .map((b) => {
      if (b.kind === "text")
        return {
          type: "text",
          text: b.text,
          ...(msg.cache_control ? { cache_control: msg.cache_control } : {}),
        };
      if (b.kind === "tool_use")
        return { type: "tool_use", id: b.tool_use_id, name: b.name, input: b.input };
      if (b.kind === "tool_result")
        return {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: [{ type: "text", text: b.output }],
          is_error: b.is_error,
        };
      return null;
    })
    .filter(Boolean);

  return { role: msg.role, content };
}

function mapStopReason(
  reason: string,
): ChatChunk & { type: "message_end" } extends { stop_reason: infer R } ? R : never {
  const map: Record<string, string> = {
    end_turn: "end_turn",
    tool_use: "tool_use",
    max_tokens: "max_tokens",
    stop_sequence: "stop_sequence",
  };
  return (map[reason] ?? "end_turn") as never;
}
