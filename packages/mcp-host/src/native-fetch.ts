import type { ToolBareName, ToolDescriptor, ToolResult, ToolSourceId } from "@knowself/contracts";
import type { IMcpClient } from "./client/types";
import { toFullName } from "./namespace";

const MAX_OUTPUT_CHARS = 60_000;

export function createNativeFetchClient(
  opts: {
    sourceId?: ToolSourceId;
    requestTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => string;
  } = {},
): IMcpClient {
  const sourceId = opts.sourceId ?? ("fetch" as ToolSourceId);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    sourceId,

    async listTools(): Promise<ToolDescriptor[]> {
      const createdAt = now();
      return [
        {
          name: toFullName(sourceId, "fetch" as ToolBareName),
          source_id: sourceId,
          bare_name: "fetch" as ToolBareName,
          description:
            "Fetch the text content of a specific http/https URL explicitly provided by the user. Do not use it to search the web or guess URLs.",
          input_schema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                format: "uri",
                description: "The exact URL to fetch.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
          tags: ["web"],
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
        if (bareName !== "fetch") {
          throw new NativeFetchInputError(`Unknown native fetch tool: ${bareName}`);
        }

        const url = readUrl(input);
        const timeoutSignal =
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(requestTimeoutMs)
            : createTimeoutSignal(requestTimeoutMs);
        const linkedSignal = signal ? combineSignals(signal, timeoutSignal) : timeoutSignal;

        const res = await fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            "User-Agent": "knowSelf/0.0.0 native-fetch",
            Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          },
          signal: linkedSignal,
        });

        const contentType = res.headers.get("content-type") ?? "text/plain";
        const text = truncate(await res.text(), MAX_OUTPUT_CHARS);
        const finishedAt = now();

        return {
          tool_use_id: "native-fetch",
          name,
          is_error: !res.ok,
          output: JSON.stringify({
            url: url.toString(),
            status: res.status,
            ok: res.ok,
            contentType,
            text,
            truncated: text.length >= MAX_OUTPUT_CHARS,
          }),
          error_code: res.ok ? null : "UPSTREAM_ERROR",
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
          tool_use_id: "native-fetch",
          name,
          is_error: true,
          output: err instanceof Error ? err.message : String(err),
          error_code: aborted
            ? "ABORTED"
            : err instanceof NativeFetchInputError
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
      // Native fetch has no child process to dispose.
    },
  };
}

class NativeFetchInputError extends Error {}

function readUrl(input: unknown): URL {
  if (!input || typeof input !== "object" || typeof (input as { url?: unknown }).url !== "string") {
    throw new NativeFetchInputError("fetch input must be an object with a string url");
  }

  let url: URL;
  try {
    url = new URL((input as { url: string }).url);
  } catch {
    throw new NativeFetchInputError("fetch input url is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NativeFetchInputError("fetch only supports http and https URLs");
  }

  return url;
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
