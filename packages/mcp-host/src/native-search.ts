import type { ToolBareName, ToolDescriptor, ToolResult, ToolSourceId } from "@knowself/contracts";
import type { IMcpClient } from "./client/types";
import { toFullName } from "./namespace";

const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";
const BING_ENDPOINT = "https://www.bing.com/search";
const MAX_RESULTS = 8;
const MAX_SNIPPET_CHARS = 500;

export function createNativeSearchClient(
  opts: {
    sourceId?: ToolSourceId;
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => string;
  } = {},
): IMcpClient {
  const sourceId = opts.sourceId ?? ("web_search" as ToolSourceId);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    sourceId,

    async listTools(): Promise<ToolDescriptor[]> {
      const createdAt = now();
      return [
        {
          name: toFullName(sourceId, "search" as ToolBareName),
          source_id: sourceId,
          bare_name: "search" as ToolBareName,
          description:
            "Search the public web in real time for current information. Use this for open-ended web lookup requests, news, lists, official sites, and questions that do not include a specific URL.",
          input_schema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The web search query.",
              },
              max_results: {
                type: "number",
                minimum: 1,
                maximum: MAX_RESULTS,
                description: "Maximum number of search results to return.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          tags: ["web", "search"],
          declared_dangerous: false,
          timeout_ms: requestTimeoutMs,
          created_at: createdAt,
        },
      ];
    },

    async invoke(
      bareName: ToolBareName,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<ToolResult> {
      const startedAt = now();
      const startedMs = Date.now();
      const name = toFullName(sourceId, bareName);

      try {
        if (bareName !== "search") {
          throw new NativeSearchInputError(`Unknown native search tool: ${bareName}`);
        }

        const { query, maxResults } = readSearchInput(input);
        const timeoutSignal =
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(requestTimeoutMs)
            : createTimeoutSignal(requestTimeoutMs);
        const linkedSignal = signal ? combineSignals(signal, timeoutSignal) : timeoutSignal;
        const search = await searchWithFallback(fetchImpl, query, maxResults, linkedSignal);
        const finishedAt = now();

        return {
          tool_use_id: "native-search",
          name,
          is_error: !search.ok,
          output: JSON.stringify({
            query,
            source: search.source,
            status: search.status,
            ok: search.ok,
            results: search.results,
            errors: search.errors,
          }),
          error_code: search.ok ? null : "UPSTREAM_ERROR",
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: Date.now() - startedMs,
          source_id: sourceId,
        };
      } catch (err) {
        const finishedAt = now();
        const aborted =
          signal?.aborted || (err instanceof DOMException && err.name === "AbortError");
        return {
          tool_use_id: "native-search",
          name,
          is_error: true,
          output: err instanceof Error ? err.message : String(err),
          error_code: aborted
            ? "ABORTED"
            : err instanceof NativeSearchInputError
              ? "INPUT_VALIDATION"
              : "UPSTREAM_ERROR",
          started_at: startedAt,
          finished_at: finishedAt,
          duration_ms: Date.now() - startedMs,
          source_id: sourceId,
        };
      }
    },

    async dispose(): Promise<void> {
      // Native search has no child process to dispose.
    },
  };
}

class NativeSearchInputError extends Error {}

function readSearchInput(input: unknown): { query: string; maxResults: number } {
  if (!input || typeof input !== "object") {
    throw new NativeSearchInputError("search input must be an object");
  }

  const query = (input as { query?: unknown }).query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new NativeSearchInputError("search input must include a non-empty query string");
  }

  const rawMaxResults = (input as { max_results?: unknown }).max_results;
  const maxResults =
    typeof rawMaxResults === "number" && Number.isFinite(rawMaxResults)
      ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(rawMaxResults)))
      : 5;

  return { query: query.trim(), maxResults };
}

function parseDuckDuckGoHtml(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const itemPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(itemPattern)) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const title = cleanHtml(match[2] ?? "");
    const snippet = truncate(cleanHtml(match[3] ?? ""), MAX_SNIPPET_CHARS);
    const url = unwrapDuckDuckGoRedirect(rawUrl);
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

async function searchWithFallback(
  fetchImpl: typeof fetch,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<{
  ok: boolean;
  source: string;
  status: number | null;
  results: Array<{ title: string; url: string; snippet: string }>;
  errors: string[];
}> {
  const errors: string[] = [];
  const engines = [
    {
      source: "duckduckgo-html",
      url: createSearchUrl(DUCKDUCKGO_ENDPOINT, "q", query),
      parse: parseDuckDuckGoHtml,
    },
    {
      source: "bing-html",
      url: createSearchUrl(BING_ENDPOINT, "q", query),
      parse: parseBingHtml,
    },
  ];

  for (const engine of engines) {
    try {
      const res = await fetchImpl(engine.url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 knowSelf/0.0.0",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal,
      });
      const html = await res.text();
      const results = res.ok ? engine.parse(html).slice(0, maxResults) : [];
      if (res.ok && results.length > 0) {
        return { ok: true, source: engine.source, status: res.status, results, errors };
      }
      errors.push(`${engine.source}: HTTP ${res.status}, results=${results.length}`);
    } catch (err) {
      errors.push(`${engine.source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: false, source: "none", status: null, results: [], errors };
}

function createSearchUrl(endpoint: string, param: string, query: string): string {
  const url = new URL(endpoint);
  url.searchParams.set(param, query);
  return url.toString();
}

function parseBingHtml(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const itemPattern = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/gi;

  for (const match of html.matchAll(itemPattern)) {
    const url = decodeHtml(match[1] ?? "");
    const title = cleanHtml(match[2] ?? "");
    const body = match[3] ?? "";
    const snippetMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = truncate(cleanHtml(snippetMatch?.[1] ?? ""), MAX_SNIPPET_CHARS);
    if (title && /^https?:\/\//i.test(url)) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function unwrapDuckDuckGoRedirect(url: string): string {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  return ctrl.signal;
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const abort = () => {
    try {
      ctrl.abort(a.reason ?? b.reason);
    } catch {
      /* already aborted */
    }
  };
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  if (a.aborted || b.aborted) abort();
  return ctrl.signal;
}
