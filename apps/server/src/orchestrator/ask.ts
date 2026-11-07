import type { ChatRequest, ChatEvent, ChatHistoryMessage, ChatChunk } from "@knowself/contracts";
import type { ContextRouter } from "@knowself/context-router";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import type { ToolRegistry } from "@knowself/mcp-host";
import { randomUUID } from "node:crypto";
import { fromChatChunk, toSseStream, makeMessageStart, makeDone, makeError } from "./sse";

const MAX_FETCHED_URLS = 3;
const MAX_FETCHED_TEXT_CHARS = 18_000;
const MAX_WEB_SEARCH_RESULTS = 6;
const OPEN_WEB_LOOKUP_LIMITATION_PROMPT =
  "The runtime cannot actively search the internet. The fetch tool can only read explicit URLs provided by the user. For open-ended web lookup requests, do not claim that live web search was performed. Explain this limitation and provide non-live reference information from existing knowledge, or ask the user for specific URLs or a configured search tool when accurate live results are required.";
const OPEN_WEB_LOOKUP_KEYWORDS = [
  "\u641c\u7d22",
  "\u68c0\u7d22",
  "\u67e5\u4e00\u4e0b",
  "\u67e5\u8be2",
  "\u67e5\u627e",
  "\u627e\u4e00\u4e0b",
  "\u5e2e\u6211\u627e",
  "\u6709\u54ea\u4e9b",
  "\u540d\u5355",
  "\u5217\u8868",
  "\u6700\u65b0",
  "\u65b0\u95fb",
  "\u5b98\u7f51",
  "\u7f51\u9875",
  "\u7f51\u7ad9",
  "\u5355\u4f4d",
  "\u516c\u53f8",
  "\u56fd\u4f01",
];

export interface RunAskDeps {
  contextRouter: ContextRouter;
  providerAdapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  settings: {
    conversation: {
      default_tools_enabled: boolean;
      default_write_back: boolean;
      max_tool_iterations: number;
    };
    tool_defaults: {
      enabled_globally: boolean;
      system_prompt_addendum: string;
    };
  };
}

export interface RunAskInput {
  req: ChatRequest;
  traceId: string;
  history: ChatHistoryMessage[];
  signal?: AbortSignal;
}

export async function* runAsk(deps: RunAskDeps, input: RunAskInput): AsyncGenerator<ChatEvent> {
  const { req, traceId, history, signal } = input;
  const msgId = randomUUID();
  const convId = req.conversation_id;
  const toolsEnabled =
    (req.tools_enabled ?? deps.settings.conversation.default_tools_enabled) &&
    deps.settings.tool_defaults.enabled_globally;

  yield makeMessageStart(convId, msgId, traceId);

  // 1. Build context
  let providerMessages: Array<Record<string, unknown>>;
  try {
    const result = await deps.contextRouter.buildContext({
      query: req.user_message,
      provider_id: req.provider_id,
      history: history.map((m) => ({
        role: m.role,
        content: m.content,
      })) as Array<Record<string, unknown>>,
      skip_l3_retrieval: false,
      force_card_keys: [],
    });
    providerMessages = result.messages;
  } catch (err) {
    yield makeError("INTERNAL", `context build failed: ${String(err)}`, traceId);
    return;
  }

  const fetchedUrlContext = toolsEnabled
    ? await fetchExplicitUrls(deps.toolRegistry, req.user_message, {
        conversationId: convId,
        messageId: msgId,
        traceId,
      })
    : [];
  const openWebLookup = fetchedUrlContext.length === 0 && looksLikeOpenWebLookup(req.user_message);
  const webSearchContext =
    toolsEnabled && openWebLookup
      ? await searchOpenWeb(deps.toolRegistry, req.user_message, {
          conversationId: convId,
          messageId: msgId,
          traceId,
        })
      : [];

  // 2. Main chat/tool loop. provider-adapter.runWithTools owns the multi-turn
  // model -> tool -> model loop, so chat-engine should invoke it only once.
  if (signal?.aborted) {
    yield makeError("ABORTED", "Request aborted", traceId);
    return;
  }

  const tools = toolsEnabled
    ? deps.toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }))
    : [];
  // If the user provided explicit URLs, we prefetch them server-side and inject
  // their content. Many aggregation providers reject tool schemas with HTTP 400,
  // so URL-prefetch turns the request back into a plain chat completion.
  const providerAllowsTools = providerSupportsTools(deps.providerAdapter, req.provider_id);
  const toolsForProvider =
    fetchedUrlContext.length > 0 || webSearchContext.length > 0 || !providerAllowsTools ? [] : tools;
  const shouldExplainOpenWebLimit =
    openWebLookup && webSearchContext.length === 0 && toolsForProvider.length === 0;
  const toolPrompt =
    toolsForProvider.length > 0 && deps.settings.tool_defaults.system_prompt_addendum
      ? [
          {
            role: "system",
            content: [
              {
                kind: "text",
                text: deps.settings.tool_defaults.system_prompt_addendum,
              },
            ],
          },
        ]
      : [];
  const fetchedPrompt =
    fetchedUrlContext.length > 0
      ? [
          {
            role: "system",
            content: [
              {
                kind: "text",
                text:
                  "以下是用户消息中明确给出的 URL 的抓取内容。回答时优先依据这些内容；如果内容不足或抓取失败，请如实说明，不要编造网页内容。\n\n" +
                  fetchedUrlContext.join("\n\n---\n\n"),
              },
            ],
          },
        ]
      : [];
  const openWebLookupPrompt = shouldExplainOpenWebLimit
    ? [
        {
          role: "system",
          content: [
            {
              kind: "text",
              text: OPEN_WEB_LOOKUP_LIMITATION_PROMPT,
            },
          ],
        },
      ]
    : [];
  const webSearchPrompt =
    webSearchContext.length > 0
      ? [
          {
            role: "system",
            content: [
              {
                kind: "text",
                text:
                  "The following are real-time web search results for the user's request. Use them as current external context, cite result titles/URLs when useful, and do not invent pages that are not present here.\n\n" +
                  webSearchContext.join("\n\n---\n\n"),
              },
            ],
          },
        ]
      : [];
  const messagesForProvider = [
    ...providerMessages,
    ...toolPrompt,
    ...fetchedPrompt,
    ...webSearchPrompt,
    ...openWebLookupPrompt,
  ];

  try {
    const baseProviderOptions = {
      provider_id: req.provider_id,
      messages: messagesForProvider,
      stream: true,
      max_tokens: 4096,
      temperature: 0,
      stop_sequences: [],
      metadata: {},
    };
    const firstAttempt = yield* streamProviderAttempt(
      deps.providerAdapter,
      {
        ...baseProviderOptions,
        tools: toolsForProvider,
      },
      signal,
      { conversationId: convId, messageId: msgId, traceId },
      toolsForProvider.length > 0,
    );

    if (firstAttempt.aborted) {
      yield makeError("ABORTED", "Request aborted", traceId);
      return;
    }

    if (firstAttempt.retryWithoutTools) {
      const fallbackMessages = [
        ...providerMessages,
        ...fetchedPrompt,
        {
          role: "system",
          content: [
            {
              kind: "text",
              text: OPEN_WEB_LOOKUP_LIMITATION_PROMPT,
            },
          ],
        },
      ];
      const retryAttempt = yield* streamProviderAttempt(
        deps.providerAdapter,
        {
          ...baseProviderOptions,
          messages: fallbackMessages,
          tools: [],
        },
        signal,
        { conversationId: convId, messageId: msgId, traceId },
        false,
      );
      if (retryAttempt.aborted) {
        yield makeError("ABORTED", "Request aborted", traceId);
        return;
      }
    }
  } catch (err) {
    yield makeError("PROVIDER_FAIL", String(err), traceId);
    return;
  }

  // 3. Done
  const writeBack = req.write_back ?? deps.settings.conversation.default_write_back;
  yield makeDone(convId, writeBack);
}

async function* streamProviderAttempt(
  providerAdapter: ProviderAdapter,
  opts: Parameters<ProviderAdapter["runWithTools"]>[0],
  signal: AbortSignal | undefined,
  ctx: { conversationId: string; messageId: string; traceId: string },
  retryToolSchema400: boolean,
): AsyncGenerator<ChatEvent, { aborted: boolean; retryWithoutTools: boolean }> {
  for await (const chunk of providerAdapter.runWithTools(opts, signal)) {
    if (signal?.aborted) {
      return { aborted: true, retryWithoutTools: false };
    }
    if (retryToolSchema400 && isToolSchemaHttp400(chunk)) {
      return { aborted: false, retryWithoutTools: true };
    }

    const events = fromChatChunk(chunk, {
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      traceId: ctx.traceId,
      now: new Date().toISOString(),
    });

    for (const ev of events) {
      yield ev;
    }
  }

  return { aborted: false, retryWithoutTools: false };
}

async function fetchExplicitUrls(
  toolRegistry: ToolRegistry,
  text: string,
  ctx: { conversationId: string; messageId: string; traceId: string },
): Promise<string[]> {
  const urls = extractHttpUrls(text).slice(0, MAX_FETCHED_URLS);
  if (urls.length === 0 || !toolRegistry.get("fetch__fetch" as never)) return [];

  const results: string[] = [];
  for (const url of urls) {
    const result = await toolRegistry.invoke({
      tool_use_id: `prefetch-${results.length + 1}`,
      name: "fetch__fetch" as never,
      input: { url },
      conversation_id: ctx.conversationId,
      message_id: ctx.messageId,
      trace_id: ctx.traceId,
    });

    if (result.is_error) {
      results.push(`[URL] ${url}\n[抓取失败] ${result.output}`);
      continue;
    }

    const parsed = parseFetchToolOutput(result.output);
    if (!parsed) {
      results.push(`[URL] ${url}\n[抓取失败] fetch 返回格式无法解析`);
      continue;
    }

    results.push(
      [
        `[URL] ${parsed.url ?? url}`,
        `[HTTP] ${parsed.status ?? "unknown"} ${parsed.contentType ?? ""}`.trim(),
        "[内容]",
        truncate(parsed.text, MAX_FETCHED_TEXT_CHARS),
      ].join("\n"),
    );
  }

  return results;
}

async function searchOpenWeb(
  toolRegistry: ToolRegistry,
  query: string,
  ctx: { conversationId: string; messageId: string; traceId: string },
): Promise<string[]> {
  if (!toolRegistry.get("web_search__search" as never)) return [];

  const result = await toolRegistry.invoke({
    tool_use_id: "prefetch-search-1",
    name: "web_search__search" as never,
    input: { query, max_results: MAX_WEB_SEARCH_RESULTS },
    conversation_id: ctx.conversationId,
    message_id: ctx.messageId,
    trace_id: ctx.traceId,
  });

  if (result.is_error) {
    return [`[WEB_SEARCH_FAILED]\n${result.output}`];
  }

  const parsed = parseSearchToolOutput(result.output);
  if (!parsed) {
    return [`[WEB_SEARCH_FAILED]\nSearch returned an unparseable result.`];
  }

  if (parsed.results.length === 0) {
    return [`[WEB_SEARCH]\nQuery: ${parsed.query}\nNo results returned.`];
  }

  return [
    [
      "[WEB_SEARCH]",
      `Query: ${parsed.query}`,
      ...parsed.results.map((item, index) =>
        [
          `${index + 1}. ${item.title}`,
          `URL: ${item.url}`,
          item.snippet ? `Snippet: ${item.snippet}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      ),
    ].join("\n"),
  ];
}

function extractHttpUrls(text: string): string[] {
  const explicit = text.match(/https?:\/\/[^\s<>"'，。；、）)]+/gi) ?? [];
  const bareDomainPattern =
    /(^|[^a-zA-Z0-9@:/._-])((?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:[/?#][^\s<>"'，。；、）)]*)?)/g;
  const bareDomains = [...text.matchAll(bareDomainPattern)]
    .map((match) => match[2] ?? "")
    .filter((url) => url.length > 0);

  const urls = [
    ...explicit,
    ...bareDomains.filter((url) => !/^https?:\/\//i.test(url)).map((url) => `https://${url}`),
  ];

  return [...new Set(urls.map((url) => url.replace(/[.,;!?]+$/g, "")))];
}

function providerSupportsTools(providerAdapter: ProviderAdapter, providerId: string): boolean {
  const providers = providerAdapter.listProviders?.();
  if (!providers) return true;

  const provider = providers.find((item) => item.id === providerId);
  return provider?.declared_supports_tools ?? true;
}

function looksLikeOpenWebLookup(text: string): boolean {
  if (extractHttpUrls(text).length > 0) return false;
  return OPEN_WEB_LOOKUP_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isToolSchemaHttp400(chunk: ChatChunk): boolean {
  return chunk.type === "error" && chunk.upstream_status === 400;
}

function parseSearchToolOutput(
  output: string,
): { query: string; results: Array<{ title: string; url: string; snippet: string }> } | null {
  try {
    const parsed = JSON.parse(output) as {
      query?: unknown;
      results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>;
    };
    if (typeof parsed.query !== "string" || !Array.isArray(parsed.results)) return null;

    return {
      query: parsed.query,
      results: parsed.results
        .map((item) => ({
          title: typeof item.title === "string" ? item.title : "",
          url: typeof item.url === "string" ? item.url : "",
          snippet: typeof item.snippet === "string" ? item.snippet : "",
        }))
        .filter((item) => item.title.length > 0 && item.url.length > 0),
    };
  } catch {
    return null;
  }
}

function parseFetchToolOutput(
  output: string,
): { url?: string; status?: number; contentType?: string; text: string } | null {
  try {
    const parsed = JSON.parse(output) as {
      url?: unknown;
      status?: unknown;
      contentType?: unknown;
      text?: unknown;
      body?: unknown;
      headers?: Record<string, unknown>;
    };
    if (typeof parsed.text === "string") {
      const result: { url?: string; status?: number; contentType?: string; text: string } = {
        text: parsed.text,
      };
      if (typeof parsed.url === "string") result.url = parsed.url;
      if (typeof parsed.status === "number") result.status = parsed.status;
      if (typeof parsed.contentType === "string") result.contentType = parsed.contentType;
      return result;
    }
    if (typeof parsed.body === "string") {
      const contentType = parsed.headers?.["content-type"] ?? parsed.headers?.["Content-Type"];
      const result: { url?: string; status?: number; contentType?: string; text: string } = {
        text: parsed.body,
      };
      if (typeof parsed.url === "string") result.url = parsed.url;
      if (typeof parsed.status === "number") result.status = parsed.status;
      if (typeof contentType === "string") result.contentType = contentType;
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[内容已截断]" : text;
}

export function runAskToStream(
  deps: RunAskDeps,
  input: RunAskInput,
): {
  stream: ReadableStream<Uint8Array>;
  getAssistantText: () => string;
} {
  const gen = runAsk(deps, input);
  let assistantText = "";

  const wrappedGen = (async function* () {
    for await (const ev of gen) {
      if (ev.type === "text_delta") {
        assistantText += (ev as unknown as { delta: string }).delta;
      }
      yield ev;
    }
  })();

  const capturedStream = toSseStream(wrappedGen);

  return { stream: capturedStream, getAssistantText: () => assistantText };
}
