/**
 * W-1：资料**写**路由的业务逻辑（被 `routes/sources.ts` 以薄委托方式调用）。
 *
 * ## 为什么单独成文件
 * `sources.ts` 原有 GET 只读实现 126 行且语义已被 263 条测试锁定；写逻辑涉及
 * 契约映射、base64 解码、sha256 去重、降级判定、提案计数，塞进同文件会突破
 * 「单文件 ≤350 行」且让只读路径的 diff 变大。拆开后 `sources.ts` 只增加
 * 两行分发，既有 GET 行为逐字不变。
 *
 * ## 处理顺序（不可换，05 §13.4 / 四工单 §3.5）
 * **鉴权 → 路由(404) → 参数(400) → 降级(503) → 数据(200/201)**
 * 鉴权在 `write-bridge.ts`，404 在 `routes/index.ts`；本模块负责后三步。
 *
 * ## 降级语义
 * `ingestion` 属装配第 3 层「可失败」。它缺失时，paste 仍通过核心
 * `sourceIntake` 落库（不调模型）；file / url 仍返回 503 +
 * `{status:"degraded", reason, layer:"ingestion"}`，因为它们需要第三层的
 * MCP 或文件摄入依赖。
 *
 * ## 去重（W-1 验收 d）
 * 按**内容 sha256** 去重：对 file 用解码后的字节、paste 用 UTF-8 文本、url 用 URL。
 * 命中已有资料时返回 `200 + 同一条 SourceStored`（不新建记录、不重复蒸馏）；
 * 新建返回 `201`。响应体**始终是 `SourceStored` 本身**（工单步骤 5 的验收口径），
 * 是否新建由状态码区分，不额外包一层 `{source, duplicate}` —— client port 的
 * `createSource(): Promise<SourceStored>` 因此可以直接 `res.json()`，零转换。
 * 去重范围取 `sources.list({limit:200})` 的首页——与面板 `PAGE_LIMIT=200` 一致，
 * 不引入新表 / 不改领域库签名。**不把哈希写进 SourceStored.metadata**：那是
 * extractor 的产物字段，写入会污染既有数据口径。
 *
 * ## 边界
 * - 只做加法：不改 `CreateSourceRequestSchema` / `SourceStoredSchema` 等既有契约。
 * - 不新建 ingestion 实例，直接复用 `services.ingestion`。
 * - `provenance` 不暴露给调用方（契约里没有该字段），写入方无法伪造。
 */
import { createHash } from "node:crypto";
import type {
  CreateSourceInput,
  CreateSourceRequest,
  IngestRequest,
  SourceStored,
  SupportedMimeType,
} from "@knowself/contracts";
import type { KnowselfServices } from "../services.js";
import {
  BadRequestError,
  degradedBody,
  type DispatchResult,
} from "./http.js";

/** `CreateSourceInputSchema` 的运行时校验在路由层手写，避免把 Zod 打进插件 bundle。 */
type Kind = CreateSourceInput["kind"];

/**
 * 浏览器按扩展名推断的 MIME → 领域库白名单。
 * `application/json` **不在** `SupportedMimeTypeSchema`（注释标「V2 启用」），
 * 故按纯文本落库；这是工单「.json 文件可上传」与既有白名单的最小兼容方案。
 */
const MIME_ALIASES: Readonly<Record<string, SupportedMimeType>> = {
  "text/plain": "text/plain",
  "text/markdown": "text/markdown",
  "text/html": "text/html",
  "text/csv": "text/csv",
  "application/json": "text/plain",
};

/** 文件字节上限（与 intake.ts 的 MAX_FILE_BYTES=50MB 对齐，这里先挡一道）。 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** base64 字符上限（契约 `content_base64` 上限 8,000,000，与写桥 12MB body 上限一致）。 */
const MAX_BASE64_LENGTH = 8_000_000;

/** 类型守卫：body 必须是对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 取可选字符串字段；类型不符直接 400，不静默丢弃。 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BadRequestError(`字段 ${key} 必须是字符串`);
  return value;
}

/**
 * 解析并校验 `POST /sources` 的传输层 DTO。
 * @throws BadRequestError 参数缺失 / 类型错 / base64 非法（→400）
 */
export function parseCreateSourceInput(raw: unknown): {
  input: CreateSourceInput;
  fileBytes: Buffer | undefined;
} {
  if (!isRecord(raw)) throw new BadRequestError("请求体必须是 JSON 对象");
  const kind = raw.kind;
  if (kind !== "file" && kind !== "url" && kind !== "paste") {
    throw new BadRequestError("字段 kind 必须是 file / url / paste");
  }

  const input: CreateSourceInput = { kind: kind as Kind };
  const title = optionalString(raw, "title");
  const url = optionalString(raw, "url");
  const text = optionalString(raw, "text");
  const mime = optionalString(raw, "mime_type");
  const b64 = optionalString(raw, "content_base64");
  if (title !== undefined) input.title = title.slice(0, 256);
  if (url !== undefined) input.url = url;
  if (text !== undefined) input.text = text;
  if (mime !== undefined) input.mime_type = mime;
  if (b64 !== undefined) input.content_base64 = b64;

  if (kind === "paste") {
    if (text === undefined || text.length === 0) {
      throw new BadRequestError("paste 类型必须提供非空 text");
    }
    if (text.length > 500_000) throw new BadRequestError("text 超过 500000 字符上限");
    return { input, fileBytes: undefined };
  }

  if (kind === "url") {
    if (url === undefined || url.length === 0) {
      throw new BadRequestError("url 类型必须提供 url");
    }
    try {
      new URL(url);
    } catch {
      throw new BadRequestError("url 不是合法地址");
    }
    return { input, fileBytes: undefined };
  }

  // kind === "file"
  if (b64 === undefined || b64.length === 0) {
    throw new BadRequestError("file 类型必须提供 content_base64");
  }
  if (b64.length > MAX_BASE64_LENGTH) {
    throw new BadRequestError("文件内容超过 base64 长度上限");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new BadRequestError("content_base64 不是合法 base64");
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new BadRequestError("文件内容为空");
  if (bytes.length > MAX_FILE_BYTES) throw new BadRequestError("文件超过 50 MB 上限");
  if (mime === undefined || MIME_ALIASES[mime] === undefined) {
    throw new BadRequestError("mime_type 不受支持（仅接受 txt / md / json / html / csv）");
  }
  return { input, fileBytes: bytes };
}

/**
 * 计算输入内容的 sha256（file 用原始字节，paste 用文本，url 用 URL 字面）。
 * 只用于去重比较，绝不写入数据库。
 */
export function contentFingerprint(
  input: CreateSourceInput,
  fileBytes: Buffer | undefined,
): string {
  const payload =
    input.kind === "file"
      ? fileBytes ?? Buffer.alloc(0)
      : input.kind === "paste"
        ? Buffer.from(input.text ?? "", "utf-8")
        : Buffer.from(input.url ?? "", "utf-8");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * 在现有资料中找内容相同的记录。
 * 用 `extracted_text` 的 sha256 比对：text/markdown/json 的 extractor 均原样保留文本
 * （见 `packages/ingestion/src/extractors/text.ts`），因此与输入指纹可直接比较。
 */
function findDuplicate(
  services: KnowselfServices,
  fingerprint: string,
  kind: Kind,
): SourceStored | undefined {
  const items = services.profileStore.sources.list({ limit: 200, offset: 0 }).items;
  return items.find(
    (source) =>
      source.kind === kind &&
      createHash("sha256").update(source.extracted_text, "utf-8").digest("hex") === fingerprint,
  );
}

/** 把传输层 DTO 映射成领域层 `CreateSourceRequest`（字段拼写在这里集中转换）。 */
function toDomainRequest(input: CreateSourceInput): CreateSourceRequest {
  if (input.kind === "paste") {
    return {
      kind: "paste",
      text: input.text ?? "",
      original_name: input.title ?? "",
      user_note: "",
      user_tags: [],
    };
  }
  if (input.kind === "url") {
    return {
      kind: "url",
      url: input.url ?? "",
      user_note: "",
      user_tags: [],
    };
  }
  return {
    kind: "file",
    original_name: input.title ?? "upload.txt",
    mime_type: MIME_ALIASES[input.mime_type ?? ""] ?? "text/plain",
    user_note: "",
    user_tags: [],
  };
}

/** 摄入层不可用的可读降级原因（沿用既有 degraded 结构，措辞不暴露路径/密钥）。 */
export function ingestionDegradedReason(services: KnowselfServices): string {
  const reason = services.degraded?.reasons.find((r) => r.includes("摄入层装配失败"));
  return reason ?? "摄入层未就绪（ingestion 服务未装配）";
}

/**
 * `POST /sources`：创建资料并（可选）立即蒸馏。
 *
 * 返回 `201 + SourceStored`；命中去重时返回 `200 + 已存在的 SourceStored`。
 * 工单验收 a 需要列表出现 kind=paste 新行；验收 b 需要 proposal 出现，因此
 * 创建成功后**同请求内触发一次蒸馏**（失败不回滚已创建的资料，错误进 source.last_error）。
 */
export async function createSource(
  services: KnowselfServices,
  raw: unknown,
): Promise<DispatchResult> {
  // ① 参数（400）：先于降级判定，未认证调用方看不到 503 reason。
  const { input, fileBytes } = parseCreateSourceInput(raw);

  // ② 去重：核心 ProfileStore 可用时，降级 paste 也保持原有幂等语义。
  const fingerprint = contentFingerprint(input, fileBytes);
  const duplicate = findDuplicate(services, fingerprint, input.kind);
  if (duplicate !== undefined) {
    return { status: 200, body: duplicate };
  }

  // ③ 降级：paste 只依赖核心本地入口；file/url 仍需要完整摄入层。
  const ingestion = services.ingestion;
  if (ingestion === undefined) {
    if (input.kind === "paste") {
      const request = toDomainRequest(input);
      if (request.kind !== "paste") {
        throw new Error("paste source request mapping failed");
      }
      const source = await services.sourceIntake.createPasteSource(request);
      return { status: 201, body: source };
    }
    return degradedBody(ingestionDegradedReason(services), "ingestion");
  }

  // ④ 数据：复用装配期那一个实例，绝不新建第二个。
  const source = await ingestion.createSource(toDomainRequest(input), fileBytes);

  // ⑤ 立即蒸馏（验收 b）：失败不回滚已落库资料，只把错误留给资料行展示。
  try {
    const ingestReq: IngestRequest = {
      provider_id: "",
      focus_hints: [],
      max_proposals: 8,
    };
    await ingestion.runDistill(source, ingestReq);
  } catch {
    // 故意吞掉：蒸馏是「尽力而为」，资料已落库；错误由领域层写进 last_error。
    // 不打印错误原文（可能含 provider 配置 / 路径），避免泄漏到日志。
  }

  return { status: 201, body: source };
}

/**
 * `POST /sources/:id/distill`：对已有资料重新蒸馏。
 *
 * 未知 id 选 **404**：与 `GET /cards/:key` 的「不存在 → 404」既有约定一致；
 * 400 在本项目专门表示「参数格式/取值错」，用于「id 缺失或非法编码」而非「记录不存在」。
 * 领域库 `sources.get()` 对未知 id 抛 `ProfileNotFoundError`，这里转成 404。
 *
 * ## 幂等（W-6/E）
 * 默认**幂等**：该 source 已有 pending 提案 → 不调模型，返回
 * `{ proposal_count: 既有条数, reused: true }`。这是为了堵住
 * 「createSource 内部已蒸一次 + REST 再蒸一次」的叠加重复。
 * 传 `{ "force": true }` 才真重蒸，并把旧 pending 替换成新的一批
 * （accepted / rejected / edited 不受影响）。
 *
 * @param body 请求体（`{}` 或 `{ force: boolean }`）；非法 force 类型 → 400
 */
export async function runDistill(
  services: KnowselfServices,
  sourceId: string,
  body: unknown = {},
): Promise<DispatchResult> {
  if (sourceId === "") throw new BadRequestError("资料 id 缺失");

  const force = parseForceFlag(body);

  const ingestion = services.ingestion;
  if (ingestion === undefined) {
    return degradedBody(ingestionDegradedReason(services), "ingestion");
  }

  let source: SourceStored;
  try {
    source = services.profileStore.sources.get(sourceId);
  } catch {
    return { status: 404, body: { error: "not_found" } };
  }

  const ingestReq: IngestRequest = {
    provider_id: "",
    focus_hints: [],
    max_proposals: 8,
    force,
  };
  const response = await ingestion.runDistill(source, ingestReq);
  // 响应体是加法扩展：`reused` **只在命中幂等时出现**，保证既有调用方
  // 拿到的字段集合逐字不变（`w1-ingest-route.test.ts` 的 toEqual 断言零回退）。
  const responseBody: { source_id: string; proposal_count: number; reused?: boolean } = {
    source_id: sourceId,
    proposal_count: response.produced_proposal_ids.length,
  };
  if (response.reused === true) responseBody.reused = true;
  return { status: 200, body: responseBody };
}

/**
 * 从请求体里读 `force`。
 *
 * @param body 请求体；非对象 / 缺失 → false
 * @returns 是否强制重蒸
 * @throws BadRequestError `force` 存在但不是布尔（→400，不静默当 false）
 */
function parseForceFlag(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const value = (body as Record<string, unknown>).force;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new BadRequestError("字段 force 必须是布尔");
  return value;
}

/**
 * `PATCH /source/:id`：改名（W-3 CRUD）。
 *
 * 只改 `original_name`（展示名），不动内容 / 状态 / 蒸馏结果。
 *
 * @param services 装配后的服务
 * @param sourceId 资料 id
 * @param raw 请求体 `{ name }`
 * @returns **200** + 写后 `SourceStored`；不存在 → **404**
 */
export function renameSource(
  services: KnowselfServices,
  sourceId: string,
  raw: unknown,
): DispatchResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const body = raw as Record<string, unknown>;
  const rawName = body.name;
  if (typeof rawName !== "string") throw new BadRequestError("字段 name 必须是字符串");
  const name = rawName.trim();
  if (name === "") throw new BadRequestError("字段 name 不能为空");
  if (name.length > 200) throw new BadRequestError("字段 name 超长（上限 200）");

  const store = services.profileStore;
  if (store === undefined) return degradedBody("核心层 profileStore 未装配", "core");

  try {
    store.sources.get(sourceId);
  } catch {
    return { status: 404, body: { error: "not_found" } };
  }
  store.sources.rename(sourceId, name);
  return { status: 200, body: store.sources.get(sourceId) };
}

/**
 * `DELETE /source/:id`：删除资料（W-3 CRUD）。
 *
 * ## 为什么是**物理删除**（与人物不同）
 * `sources` 表没有 `archived` 状态（`status` 只有 raw/distilling/pending_review/completed/rejected/distill_failed），
 * 而本批约定「不改 schema」。所以这里如实物理删除，并把级联后果一起回报：
 * `ingestion_proposals.source_id` / `profile_sources.source_id` 都是 `ON DELETE CASCADE`。
 *
 * ## 护栏
 * 已经**产出过已采纳提案**的资料不允许直接删（那意味着画像/消息已经引用了它），
 * 必须显式带 `?force=1`。理由：一次误点会连带删掉审计链，且无法撤销。
 *
 * @param services 装配后的服务
 * @param sourceId 资料 id
 * @param force 是否强制（来自 `?force=1`）
 * @returns **200** `{ id, deleted:true, cascaded_proposals }`；不存在 → 404；被引用且未 force → 409
 */
export function deleteSource(
  services: KnowselfServices,
  sourceId: string,
  force: boolean,
): DispatchResult {
  const store = services.profileStore;
  if (store === undefined) return degradedBody("核心层 profileStore 未装配", "core");

  try {
    store.sources.get(sourceId);
  } catch {
    return { status: 404, body: { error: "not_found" } };
  }

  const accepted = store.proposals
    .listByStatus("accepted")
    .filter((proposal) => proposal.source_id === sourceId).length;
  if (accepted > 0 && !force) {
    return {
      status: 409,
      body: {
        error: "source_has_accepted_proposals",
        accepted_proposals: accepted,
        hint: "该资料已产出过已采纳的提案，删除会连带清掉它们；确认请带 ?force=1",
      },
    };
  }

  const all = ["pending", "accepted", "rejected", "edited"].reduce((sum, status) => {
    const rows = store.proposals.listByStatus(status as never).filter((p) => p.source_id === sourceId);
    return sum + rows.length;
  }, 0);

  store.sources.delete(sourceId);
  return { status: 200, body: { id: sourceId, deleted: true, cascaded_proposals: all } };
}
