import type { ChatOptions, ChatChunk, ProviderMessage, ToolDescriptor } from "@knowself/contracts";
import type { ToolRegistry } from "@knowself/mcp-host";
import { chat } from "./chat";
import type { createRegistry } from "./registry";

export interface RunWithToolsConfig {
  maxIterations: number;
}

export async function* runWithTools(
  deps: {
    registry: ReturnType<typeof createRegistry>;
    toolRegistry: ToolRegistry;
    fetchImpl?: typeof fetch;
  },
  opts: ChatOptions & { messages: ProviderMessage[] },
  config: RunWithToolsConfig,
  signal?: AbortSignal,
): AsyncIterable<ChatChunk> {
  const messages = [...opts.messages];
  let iteration = 0;

  while (iteration < config.maxIterations) {
    if (signal?.aborted) {
      yield {
        type: "error",
        upstream_status: null,
        message: "Aborted",
        retryable: false,
      } satisfies ChatChunk;
      return;
    }

    const allowedToolNames = new Set((opts.tools ?? []).map((t) => t.name));
    const tools =
      allowedToolNames.size > 0
        ? deps.toolRegistry.list().filter((t) => allowedToolNames.has(t.name))
        : [];
    const toolDescriptors = tools.map(
      (t): ToolDescriptor => ({
        name: t.name,
        source_id: t.source_id,
        bare_name: t.bare_name,
        description: t.description,
        input_schema: t.input_schema,
        tags: t.tags,
        declared_dangerous: t.declared_dangerous,
        timeout_ms: t.timeout_ms,
        created_at: t.created_at,
      }),
    );

    const toolUses: Array<{
      tool_use_id: string;
      name: string;
      input: unknown;
    }> = [];

    const streamOpts: ChatOptions = {
      ...opts,
      messages,
      tools: toolDescriptors.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    };

    for await (const chunk of chat(deps, streamOpts, signal)) {
      if (chunk.type === "tool_use") {
        toolUses.push({
          tool_use_id: chunk.tool_use_id,
          name: chunk.name,
          input: chunk.input,
        });
      }

      yield chunk;

      if (chunk.type === "message_end") {
        const legacy = chunk as { stop_reason: string };
        if (legacy.stop_reason === "end_turn") return;
        if (legacy.stop_reason !== "tool_use") return;
      }

      if (chunk.type === "error") return;
    }

    // Execute tools
    const assistantContent: ProviderMessage["content"] = [];

    for (const tu of toolUses) {
      assistantContent.push({
        kind: "tool_use",
        tool_use_id: tu.tool_use_id,
        name: tu.name,
        input: tu.input,
      });
    }

    messages.push({
      role: "assistant",
      content: assistantContent.length > 0 ? assistantContent : [{ kind: "text", text: "" }],
    });

    const toolResults: ProviderMessage["content"] = [];

    for (const tu of toolUses) {
      const _startedAt = Date.now();
      const result = await deps.toolRegistry.invoke({
        tool_use_id: tu.tool_use_id,
        name: tu.name,
        input: tu.input,
        conversation_id: "tool-run",
        message_id: tu.tool_use_id,
        trace_id: tu.tool_use_id,
      });

      toolResults.push({
        kind: "tool_result",
        tool_use_id: tu.tool_use_id,
        is_error: result.is_error,
        output: result.output,
      });

      yield {
        type: "tool_use",
        tool_use_id: tu.tool_use_id,
        name: tu.name,
        input: tu.input,
      } satisfies ChatChunk;

      yield {
        type: "message_end",
        stop_reason: "tool_use",
      } satisfies ChatChunk;
    }

    messages.push({
      role: "tool",
      content: toolResults,
    });

    iteration++;
  }

  yield {
    type: "error",
    upstream_status: null,
    message: `Tool loop exceeded max iterations (${config.maxIterations})`,
    retryable: false,
  } satisfies ChatChunk;
}
