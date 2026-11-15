/**
 * intake.ts — createSource 入口
 *
 * 按 kind 分支：file / url / paste。
 * 1. 校验 MIME（url 分支要查 fetch 返回的 content-type）
 * 2. 选 extractor 抽取 RawText
 * 3. 写 sources 表
 * 4. 存字节文件（file 分支）
 */

import type { CreateSourceRequest, SourceStored, SupportedMimeType } from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ToolRegistry } from "@knowself/mcp-host";
import { pickExtractor } from "./extractors/index";
import { isSupportedMime } from "./mime";
import { saveSourceFile } from "./files";
import { fetchUrlAsSource } from "./url-fetcher";
import { UnsupportedMimeError, SourceNotFoundError } from "./errors";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACT_CHARS = 1_000_000;
const TRUNCATION_MAX_CHARS = 1_000_000;

/** createSource 的依赖。 */
export interface IntakeDeps {
  store: ProfileStore;
  toolRegistry: ToolRegistry;
  sourcesDir: string;
  conversationId: string;
  now?: () => string;
}

/**
 * 创建纯文本资料所需的最小依赖。
 *
 * Paste 不触及 MCP、Provider 或文件目录，因此可在完整摄入层降级时继续作为
 * 本地资料持久化入口使用。
 */
export interface SourceIntakeDeps {
  store: ProfileStore;
  now?: () => string;
}

/** 不依赖模型和外部工具的窄资料入口。 */
export interface SourceIntake {
  createPasteSource(
    req: Extract<CreateSourceRequest, { kind: "paste" }>,
  ): Promise<SourceStored>;
}

/** 创建用于 paste 资料的核心本地入口。 */
export function createSourceIntake(deps: SourceIntakeDeps): SourceIntake {
  return {
    createPasteSource(req) {
      if (req.idempotency_key) {
        const existing = deps.store.sources.findByIdempotencyKey(req.idempotency_key);
        if (existing) return Promise.resolve(existing);
      }
      const now = deps.now ?? (() => new Date().toISOString());
      return createFromPaste(deps, req, crypto.randomUUID(), now);
    },
  };
}

/**
 * 创建一条 source 记录。
 * file 分支接收 fileBytes；url 分支内部 fetch；paste 直接用 text。
 */
export async function createSource(
  deps: IntakeDeps,
  req: CreateSourceRequest,
  fileBytes?: Buffer,
): Promise<SourceStored> {
  if (req.idempotency_key) {
    const existing = deps.store.sources.findByIdempotencyKey(req.idempotency_key);
    if (existing) return existing;
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const sourceId = crypto.randomUUID();

  if (req.kind === "file") {
    return createFromFile(deps, req, fileBytes, sourceId, now);
  } else if (req.kind === "url") {
    return createFromUrl(deps, req, sourceId, now);
  } else {
    return createFromPaste(deps, req, sourceId, now);
  }
}

async function createFromFile(
  deps: IntakeDeps,
  req: CreateSourceRequest & { kind: "file" },
  fileBytes: Buffer | undefined,
  sourceId: string,
  now: () => string,
): Promise<SourceStored> {
  if (!fileBytes || fileBytes.length === 0) {
    throw new SourceNotFoundError("empty file");
  }
  if (fileBytes.length > MAX_FILE_BYTES) {
    throw new SourceNotFoundError(`file too large: ${fileBytes.length}`);
  }

  const mime = req.mime_type;
  if (!isSupportedMime(mime)) {
    throw new UnsupportedMimeError(mime);
  }

  const extractor = pickExtractor(mime);
  const rawText = await extractor.extract(fileBytes, {
    mimeType: mime,
    originalName: req.original_name,
    maxChars: MAX_EXTRACT_CHARS,
  });

  const filePath = await saveSourceFile(deps.sourcesDir, sourceId, fileBytes, mime);

  const source: SourceStored = {
    id: sourceId,
    ...(req.idempotency_key ? { idempotency_key: req.idempotency_key } : {}),
    kind: "file",
    original_name: req.original_name,
    mime_type: mime,
    file_path: filePath,
    url: null,
    extracted_text: rawText.text.slice(0, TRUNCATION_MAX_CHARS),
    truncated: rawText.text.length > TRUNCATION_MAX_CHARS,
    char_count: rawText.text.length,
    user_note: req.user_note ?? "",
    user_tags: req.user_tags ?? [],
    status: "raw",
    metadata: rawText.metadata as Record<string, unknown>,
    created_at: now(),
    last_ingested_at: null,
    last_error: null,
  };

  deps.store.sources.insert(source);
  return source;
}

async function createFromUrl(
  deps: IntakeDeps,
  req: CreateSourceRequest & { kind: "url" },
  sourceId: string,
  now: () => string,
): Promise<SourceStored> {
  const { text, contentType } = await fetchUrlAsSource(
    { toolRegistry: deps.toolRegistry, conversationId: deps.conversationId },
    req.url,
  );

  const mime = normalizeContentType(contentType);

  const extractor = pickExtractor(mime as SupportedMimeType);
  const urlBaseName = tryParseUrlBasename(req.url) || "fetched.html";
  const rawText = await extractor.extract(text, {
    mimeType: mime as SupportedMimeType,
    originalName: urlBaseName,
    maxChars: MAX_EXTRACT_CHARS,
  });

  const source: SourceStored = {
    id: sourceId,
    ...(req.idempotency_key ? { idempotency_key: req.idempotency_key } : {}),
    kind: "url",
    original_name: urlBaseName,
    mime_type: mime as SupportedMimeType,
    file_path: null,
    url: req.url,
    extracted_text: rawText.text.slice(0, TRUNCATION_MAX_CHARS),
    truncated: rawText.text.length > TRUNCATION_MAX_CHARS,
    char_count: rawText.text.length,
    user_note: req.user_note ?? "",
    user_tags: req.user_tags ?? [],
    status: "raw",
    metadata: rawText.metadata as Record<string, unknown>,
    created_at: now(),
    last_ingested_at: null,
    last_error: null,
  };

  deps.store.sources.insert(source);
  return source;
}

async function createFromPaste(
  deps: SourceIntakeDeps,
  req: CreateSourceRequest & { kind: "paste" },
  sourceId: string,
  now: () => string,
): Promise<SourceStored> {
  const name = req.original_name || req.text.slice(0, 30);
  const mime: SupportedMimeType = "text/plain";

  const extractor = pickExtractor(mime);
  const rawText = await extractor.extract(req.text, {
    mimeType: mime,
    originalName: name,
    maxChars: MAX_EXTRACT_CHARS,
  });

  const source: SourceStored = {
    id: sourceId,
    ...(req.idempotency_key ? { idempotency_key: req.idempotency_key } : {}),
    kind: "paste",
    original_name: name,
    mime_type: mime,
    file_path: null,
    url: null,
    extracted_text: rawText.text.slice(0, TRUNCATION_MAX_CHARS),
    truncated: rawText.text.length > TRUNCATION_MAX_CHARS,
    char_count: rawText.text.length,
    user_note: req.user_note ?? "",
    user_tags: req.user_tags ?? [],
    status: "raw",
    metadata: rawText.metadata as Record<string, unknown>,
    created_at: now(),
    last_ingested_at: null,
    last_error: null,
  };

  deps.store.sources.insert(source);
  return source;
}

/**
 * 常见 content-type 值映射到 SupportedMimeType。
 * 不匹配时尝试 isSupportedMime，都不行就抛错。
 */
function normalizeContentType(ct: string): string {
  const cleaned = ct.split(";")[0]!.trim().toLowerCase();
  if (isSupportedMime(cleaned)) return cleaned;

  // 常见别名
  const alias: Record<string, string> = {
    "text/x-markdown": "text/markdown",
  };
  if (alias[cleaned]) return alias[cleaned];

  throw new UnsupportedMimeError(cleaned);
}

/** 从 URL 解析末段文件名。 */
function tryParseUrlBasename(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || "";
    return base || "index.html";
  } catch {
    return "fetched";
  }
}
