/**
 * 发送者解析与 `ensurePersonForUid`（DESIGN-13 §2.2 / §4.1；DESIGN-11 §4.5 / §7.5）。
 * 幂等不变量：同一 `(platform, platform_uid)` 永远解析到同一个 `person_id`；
 * 已存在时**不覆盖 `display_name`**（人工优先，FR-8.6）。
 */
import { randomUUID } from "node:crypto";
import type { AliasesRepo } from "./repository/aliases";
import type { PersonsRepo } from "./repository/persons";
import type { AliasKind, AliasPlatform } from "./types";

/** `store.ensurePersonForUid` 入参（DESIGN-13 §4.1；DESIGN-11 §7.5 的加法式可选参数）。 */
export interface EnsurePersonForUidInput {
  platform: AliasPlatform;
  platform_uid: string;
  display_name: string;
  /** 缺省 `'platform_uid'`；伪 ID 亦用该 kind，`alias='name:<normalized>'`（DESIGN-11 §4.5）。 */
  alias_kind?: AliasKind;
  /** 缺省 `1.0`；伪 ID 传 `0.6`（DESIGN-11 §4.5）。 */
  confidence?: number;
  now: string;
}

/** DESIGN-11 §7.5 返回形态：`created=false` 表示复用既有 `person_id`。 */
export interface EnsurePersonForUidResult {
  person_id: string;
  created: boolean;
}

/** 归一化（contracts/src/person.ts `AliasSchema.normalized` 口径：去空白、去 emoji、小写）。 */
export function normalizeAlias(raw: string): string {
  return raw
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

export interface IdentityDeps {
  persons: PersonsRepo;
  aliases: AliasesRepo;
  transaction<T>(fn: () => T): T;
}

/** `v_chat_messages` 的发送者解析口径（只读，不写任何表）。 */
export function resolveSenderPersonId(
  deps: Pick<IdentityDeps, "aliases">,
  platform: string,
  senderId: string,
): string | null {
  return deps.aliases.resolvePersonId(platform, senderId);
}

/**
 * 首次遇到某 `sender_id`：建 `persons`（`subject_kind='contact'`）+ `aliases`
 * （`source='extractor'`；默认 `alias_kind='platform_uid'`、`confidence=1.0`；
 * 伪 ID 传 `confidence=0.6` 且 `platform_uid='name:<normalized>'`，DESIGN-11 §4.5）。
 * 幂等判定只查 `alias_kind='platform_uid'`（`resolvePersonId` 口径）——调用方若传其他 kind，
 * 本入口不负责去重（DESIGN-11 §4.5 规定伪 ID 亦用 `platform_uid`）。
 */
export function ensurePersonForUid(
  deps: IdentityDeps,
  input: EnsurePersonForUidInput,
): EnsurePersonForUidResult {
  const existing = deps.aliases.resolvePersonId(input.platform, input.platform_uid);
  if (existing) return { person_id: existing, created: false };

  const personId = randomUUID();
  deps.transaction(() => {
    deps.persons.insert(
      { person_id: personId, subject_kind: "contact", display_name: input.display_name },
      input.now,
    );
    deps.aliases.insert(
      {
        alias_id: randomUUID(),
        person_id: personId,
        platform: input.platform,
        alias_kind: input.alias_kind ?? "platform_uid",
        alias: input.platform_uid,
        normalized: normalizeAlias(input.platform_uid),
        is_primary: true,
        confidence: input.confidence ?? 1.0,
        source: "extractor",
      },
      input.now,
    );
  });
  return { person_id: personId, created: true };
}
