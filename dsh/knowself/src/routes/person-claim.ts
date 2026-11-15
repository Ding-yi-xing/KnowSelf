/**
 * W29 B1：认领「未识别」人物 / 单聊会话节点（`POST /write/person/claim`）。
 *
 * ## 通道
 * 只认 handler 型写通道：`ctx.writeChannel === true && POST && /person/claim`。
 * 不带 `/write` 的直调仍返回 `undefined` → 404（`routes/persons.ts:159-161` 不吞请求），
 * `write-bridge.ts` 的六道守卫零改动即可放行本路径。
 *
 * ## 顺序（不可换）
 *   参数(400) → 人物层降级(503) → 查 alias(409) → 事务(201) → 排一次图谱刷新。
 *
 * ## 事务边界
 * `createManualPerson`（内部 `manual_locked=1`）与 `aliases.insert` 在**同一事务**内。
 * 历史消息**不做迁移/重挂**：`v_chat_messages` 通过 `(platform,'platform_uid',alias=sender_id)`
 * JOIN 自动解析归属，补上 alias 即可；真实库里 sender_id 多为 `name:` 形态，
 * 因此真机上不会自动重挂——这是数据现状，不在本端点里硬修生产逻辑。
 *
 * ## 为什么不复用 `ensurePersonForUid`
 * 后者是 extractor 语义（复用既有 person、不报 409、source=extractor），
 * 与「用户主动认领、重复必须 409、人工锁定」的契约不同。
 */
import { randomUUID } from "node:crypto";
import type { KnowselfServices } from "../services.js";
import { scheduleGraphRefresh } from "../graph-refresh.js";
import { BadRequestError, degradedBody, type DispatchResult, type RouteContext } from "./http.js";
import { personDegradedReason } from "./persons.js";

/** 认领显示名长度上限（**单独用 40**，不复用 `persons-write.ts` 的 120）。 */
const MAX_CLAIM_NAME_CHARS = 40;
/** `sender_ref` 的平台前缀；slice 后即 alias 值。 */
const WECHAT_PREFIX = "wechat:";

/** 把原始请求体规整成对象。 */
function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

/** 校验并取出 `wechat:` 前缀后的 uid。 */
function readSenderRef(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestError("字段 sender_ref 必须是字符串");
  }
  const value = raw.trim();
  if (!value.startsWith(WECHAT_PREFIX)) {
    throw new BadRequestError("字段 sender_ref 必须以 wechat: 开头");
  }
  const uid = value.slice(WECHAT_PREFIX.length);
  if (uid === "") throw new BadRequestError("字段 sender_ref 的 uid 不能为空");
  return uid;
}

/** 校验显示名（按码点计数，避免 emoji/中文被 .length 误判）。 */
function readDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequestError("字段 display_name 必须是字符串");
  }
  const name = raw.trim();
  if (name === "") throw new BadRequestError("字段 display_name 不能为空");
  if (Array.from(name).length > MAX_CLAIM_NAME_CHARS) {
    throw new BadRequestError(`字段 display_name 超长（上限 ${MAX_CLAIM_NAME_CHARS} 字）`);
  }
  return name;
}

/**
 * 取人物库；未装配时返回 `undefined`（由调用方转 503）。
 * @param services 装配后的服务
 */
function personStoreOf(services: KnowselfServices): KnowselfServices["personStore"] {
  return services.personStore;
}

/**
 * 处理认领写端点。
 *
 * @param ctx 路由上下文（`path` 已去掉 `/knowself-api` 与 `/write` 前缀）
 * @returns 命中的 `{ status, body }`；非写通道 / 非 POST / 非本路径 → `undefined`
 * @throws BadRequestError 参数非法（400，由 bridge 统一收敛）
 */
export function handlePersonClaimRoute(ctx: RouteContext): DispatchResult | undefined {
  if (ctx.writeChannel !== true || ctx.method !== "POST" || ctx.path !== "/person/claim") {
    return undefined;
  }

  // ① 参数（400）先于一切：参数错不得被误报成降级或冲突。
  const body = asObject(ctx.body);
  const senderId = readSenderRef(body.sender_ref);
  const displayName = readDisplayName(body.display_name);

  // ② 人物层惰性解析：缺失 → 与其它人物端点一致的 503 文案。
  const store = personStoreOf(ctx.services);
  if (store === undefined) {
    return degradedBody(personDegradedReason(ctx.services), "person");
  }

  // ③ 幂等/冲突：该 uid 已有别名 → 409，不重复建人。
  if (store.aliases.findByUid("wechat", senderId) !== null) {
    return {
      status: 409,
      body: {
        error: "alias_already_claimed",
        hint: "这个人已经被认领过了",
      },
    };
  }

  // ④ 单事务：建人工人物 + 写 platform_uid 别名；成功后排一次图谱刷新。
  const now = new Date().toISOString();
  const personId = store.transaction(() => {
    const person = store.persons.createManualPerson({ display_name: displayName }, now);
    store.aliases.insert(
      {
        alias_id: randomUUID(),
        person_id: person.person_id,
        platform: "wechat",
        alias_kind: "platform_uid",
        alias: senderId,
        normalized: senderId,
        is_primary: true,
        confidence: 1.0,
        source: "manual",
      },
      now,
    );
    return person.person_id;
  });
  const graphRefresh = scheduleGraphRefresh(store);

  return {
    status: 201,
    body: {
      person_id: personId,
      display_name: displayName,
      // 字段名是 `kind`，不是 `alias_kind`（与 B2 端口契约一致）。
      alias: { platform: "wechat", kind: "platform_uid", alias: senderId },
      graph_refresh: graphRefresh,
    },
  };
}
