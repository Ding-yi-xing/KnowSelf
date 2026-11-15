/**
 * W-3：人物**写**路由（`POST /persons` / `PATCH /person/:id` / `POST /person/:id/merge` / `DELETE /person/:id`）。
 *
 * ## 为什么单独成文件
 * `routes/persons.ts` 是 161 行的只读实现，且被既有测试逐字锁定；把写逻辑塞进去会破坏
 * 「只读路径 diff 为零」的纪律。这里只做【参数校验 → 降级判定 → 调领域库 → 回写后状态】。
 *
 * ## 回落约定（与既有端点一致，不新造错误码）
 *   - 参数不合法 → 抛 `BadRequestError`（bridge 统一转 **400**）；
 *   - 人物层未装配 → **503** `{status:"degraded", reason, layer:"person"}`；
 *   - id 不存在 → **404** `{error:"not_found"}`；
 *   - 业务拒绝（自合并等）→ **400** + 可读 message（不走 500，那不是服务器故障）；
 *   - 其余异常上抛 → bridge 转 **500** 并脱敏。
 *
 * ## 「删除」的语义（重要）
 * `persons` 表**没有物理删除**：`status` 只有 `active/archived/merged`，
 * 且 `chat_messages` 是 append-only、`v_chat_messages` 通过别名 JOIN 解析归属。
 * 所以本端点做的是**归档**（`status='archived'`），并在响应里明确 `deleted: false, archived: true`
 * —— 绝不谎称"已物理删除"。要彻底抹除需另立工单（涉及 append-only 与审计链）。
 *
 * ## merge 的原子性
 * 归并三步（迁别名 → 标记源 merged → 写审计）在 `@knowself/person-store` 的
 * `mergePersons()` 里由**单个事务**完成。历史消息**不需要迁移**：
 * `sender_person_id` 是视图列（`v_chat_messages` JOIN aliases），别名一挪，全部历史自动改指向。
 */
import { mergePersons, MergeRejectedError } from "@knowself/person-store";
import type { PersonRow } from "@knowself/person-store";
import type { KnowselfServices } from "../services.js";
import { BadRequestError, degradedBody, sanitizeReason, type DispatchResult } from "./http.js";
import { personDegradedReason } from "./persons.js";
import { scheduleGraphRefresh } from "../graph-refresh.js";

/** 显示名 / 备注长度上限（防御性：UI 是单行输入，超长一定是脚本或误用）。 */
const MAX_NAME_LENGTH = 120;
const MAX_NOTE_LENGTH = 2000;

/**
 * 取人物库；未装配时返回 `undefined`（由调用方转 503）。
 * @param services 装配后的服务
 */
function personStoreOf(services: KnowselfServices): KnowselfServices["personStore"] {
  return services.personStore;
}

/**
 * 把原始 body 规整成对象。
 * @throws BadRequestError 不是 JSON 对象
 */
function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

/**
 * 读取并校验显示名。
 * @param raw 原始值
 * @param required 是否必填
 * @returns 去空白后的名字；`required=false` 且缺省时返回 `undefined`
 * @throws BadRequestError 类型不对 / 空串 / 超长
 */
function readName(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined) {
    if (required) throw new BadRequestError("字段 display_name 必填");
    return undefined;
  }
  if (typeof raw !== "string") throw new BadRequestError("字段 display_name 必须是字符串");
  const name = raw.trim();
  if (name === "") throw new BadRequestError("字段 display_name 不能为空");
  if (name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(`字段 display_name 超长（上限 ${MAX_NAME_LENGTH}）`);
  }
  return name;
}

/**
 * 读取并校验备注（可空串：用户可能就是想清空备注）。
 * @param raw 原始值
 * @returns 备注；缺省返回 `undefined`
 * @throws BadRequestError 类型不对 / 超长
 */
function readNote(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadRequestError("字段 note 必须是字符串");
  const note = raw.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new BadRequestError(`字段 note 超长（上限 ${MAX_NOTE_LENGTH}）`);
  }
  return note;
}

/**
 * 读取 id 字符串字段（用于 `target_person_id`）。
 * @throws BadRequestError 缺失 / 非字符串 / 空串
 */
function readIdField(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new BadRequestError(`字段 ${field} 必须是非空字符串`);
  }
  return raw.trim();
}

/** 归档后的返回体（明确区分「归档」与「物理删除」）。 */
function archivedBody(
  person: PersonRow,
  graphRefresh?: { scheduled: boolean; debounce_ms: number },
): DispatchResult {
  return {
    status: 200,
    body: { ...person, deleted: false, archived: true, ...(graphRefresh === undefined ? {} : { graph_refresh: graphRefresh }) },
  };
}

/**
 * `POST /persons`：人工新建一个人物。
 *
 * @param services 装配后的服务
 * @param raw 请求体 `{ display_name, note? }`
 * @returns **201** + 写后 `PersonRow`
 */
export function createPerson(services: KnowselfServices, raw: unknown): DispatchResult {
  const body = asObject(raw);
  const displayName = readName(body.display_name, true) as string;
  const note = readNote(body.note);

  const store = personStoreOf(services);
  if (store === undefined) return degradedBody(personDegradedReason(services), "person");

  const now = new Date().toISOString();
  const person = store.persons.createManualPerson(
    { display_name: displayName, ...(note === undefined ? {} : { note }) },
    now,
  );
  return { status: 201, body: person };
}

/**
 * `PATCH /person/:id`：改名 / 改备注（人工编辑 → `manual_locked=1`）。
 *
 * @param services 装配后的服务
 * @param personId 人物 id
 * @param raw 请求体 `{ display_name?, note? }`；两个都缺省视为 400（无意义请求）
 * @returns **200** + 写后 `PersonRow`
 */
export function updatePerson(
  services: KnowselfServices,
  personId: string,
  raw: unknown,
): DispatchResult {
  const body = asObject(raw);
  const displayName = readName(body.display_name, false);
  const note = readNote(body.note);
  if (displayName === undefined && note === undefined) {
    throw new BadRequestError("至少要提供 display_name 或 note 之一");
  }

  const store = personStoreOf(services);
  if (store === undefined) return degradedBody(personDegradedReason(services), "person");

  const existing = store.persons.get(personId);
  if (existing === null) return { status: 404, body: { error: "not_found" } };

  const now = new Date().toISOString();
  const updated = store.persons.updateManual(
    personId,
    {
      ...(displayName === undefined ? {} : { display_name: displayName }),
      ...(note === undefined ? {} : { remark: note }),
    },
    now,
  );
  // 图谱写死在快照里的 label：改名后必须重算一次，否则"改了名、图谱还是旧的"。
  // 只改名才需要（改备注不进图谱）；节流在 graph-refresh 里做。
  const graphRefresh = displayName === undefined ? undefined : scheduleGraphRefresh(store);
  return { status: 200, body: { ...updated, ...(graphRefresh === undefined ? {} : { graph_refresh: graphRefresh }) } };
}

/**
 * `POST /person/:id/merge`：把 `:id` 并入 `target_person_id`（单事务）。
 *
 * @param services 装配后的服务
 * @param fromPersonId 源人物（会被标记 `merged`）
 * @param raw 请求体 `{ target_person_id, reason? }`
 * @returns **200** + `{ from, to, moved_aliases, dropped_duplicate_aliases }`
 */
export function mergePerson(
  services: KnowselfServices,
  fromPersonId: string,
  raw: unknown,
): DispatchResult {
  const body = asObject(raw);
  const targetId = readIdField(body.target_person_id, "target_person_id");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : undefined;

  const store = personStoreOf(services);
  if (store === undefined) return degradedBody(personDegradedReason(services), "person");

  if (store.persons.get(fromPersonId) === null) return { status: 404, body: { error: "not_found" } };
  if (store.persons.get(targetId) === null) {
    return { status: 404, body: { error: "not_found", detail: "target_person_id 不存在" } };
  }

  try {
    const result = mergePersons(store, {
      from_person_id: fromPersonId,
      to_person_id: targetId,
      ...(reason === undefined ? {} : { reason }),
    });
    // 合并会改变节点集合与 label（源节点消失、别名挪到目标），必须重算快照
    return { status: 200, body: { ...result, graph_refresh: scheduleGraphRefresh(store) } };
  } catch (err) {
    if (err instanceof MergeRejectedError) {
      // 业务拒绝（自合并 / 重复合并）：400，不是 500
      return { status: 400, body: { error: sanitizeReason(err.message, "无法合并") } };
    }
    throw err;
  }
}

/**
 * `DELETE /person/:id`：**归档**（不是物理删除，见文件头注）。
 *
 * @param services 装配后的服务
 * @param personId 人物 id
 * @returns **200** + `{ ...person, deleted:false, archived:true }`；不存在 → 404；`me` → 400
 */
export function archivePerson(services: KnowselfServices, personId: string): DispatchResult {
  const store = personStoreOf(services);
  if (store === undefined) return degradedBody(personDegradedReason(services), "person");

  if (personId === "me") {
    return { status: 400, body: { error: "不能归档「我」" } };
  }
  const existing = store.persons.get(personId);
  if (existing === null) return { status: 404, body: { error: "not_found" } };
  if (existing.status === "archived") return archivedBody(existing);

  const now = new Date().toISOString();
  // `manual_locked=1` 由 `updateManual` 自动置位：归档是人的决定，别被自动写复活。
  const archived = store.persons.updateManual(personId, { status: "archived" }, now);
  // 归档会让节点从图谱消失，同样要重算
  return archivedBody(archived, scheduleGraphRefresh(store));
}
