import type { ProviderConfig, ChatOptions, ChatChunk, ProviderMessage } from "@knowself/contracts";
import type { IAdapter } from "./types";
import type { SseEvent } from "../stream";

export function createOpenAiAdapter(config: ProviderConfig): IAdapter {
  return {
    protocol: "openai",

    encodeRequest(opts: ChatOptions): { url: string; init: RequestInit } {
      const msgs = opts.messages as ProviderMessage[];
      const body: Record<string, unknown> = {
        model: config.model,
        messages: msgs.map(convertMessage),
        stream: opts.stream,
        max_tokens: opts.max_tokens,
      };

      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.top_p !== undefined) body.top_p = opts.top_p;
      if (opts.stop_sequences?.length) body.stop = opts.stop_sequences;
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      }

      return {
        url: `${config.base_url}/chat/completions`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.api_key}`,
            ...config.extra_headers,
          },
          body: JSON.stringify(body),
        },
      };
    },

    async *decodeStream(events: AsyncIterable<SseEvent>): AsyncIterable<ChatChunk> {
      let toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const evt of events) {
        if (!evt.data || evt.data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(evt.data);
          const choice = chunk.choices?.[0];

          if (choice?.delta?.content) {
            yield {
              type: "text",
              delta: choice.delta.content,
            } satisfies ChatChunk;
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx: number = tc.index;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, {
                  id: tc.id ?? `call_${idx}`,
                  name: tc.function?.name ?? "",
                  args: tc.function?.arguments ?? "",
                });
              } else {
                const existing = toolCalls.get(idx)!;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
                if (tc.function?.name) existing.name = tc.function.name;
              }
            }
          }

          if (choice?.finish_reason) {
            for (const [, tc] of toolCalls) {
              let input: unknown = {};
              try {
                input = JSON.parse(tc.args);
              } catch {
                input = tc.args;
              }
              yield {
                type: "tool_use",
                tool_use_id: tc.id,
                name: tc.name,
                input,
              } satisfies ChatChunk;
            }
            toolCalls = new Map();

            const stopReason = mapFinishReason(choice.finish_reason);
            yield {
              type: "message_end",
              stop_reason: stopReason,
            } satisfies ChatChunk;
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    },
  };
}

function convertMessage(msg: ProviderMessage): Record<string, unknown> {
  const role = msg.role;
  const rawContent = msg.content
    .map((b) => {
      if (b.kind === "text") return { type: "text" as const, text: b.text };
      if (b.kind === "tool_use") return null;
      if (b.kind === "tool_result")
        return { role: "tool" as const, content: b.output, tool_call_id: b.tool_use_id };
      return null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const textOnly = rawContent.filter((c) => "type" in c && c.type === "text");
  if (textOnly.length === 1 && textOnly.length === rawContent.length && "text" in textOnly[0]!) {
    return { role, content: textOnly[0].text };
  }
  return { role, content: rawContent };
}

function mapFinishReason(
  reason: string,
): ChatChunk & { type: "message_end" } extends { stop_reason: infer R } ? R : never {
  const map: Record<string, string> = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
  };
  return (map[reason] ?? "end_turn") as never;
}
