/**
 * T03：能力快照缓存的**指纹语义**回归锁。
 *
 * 两条不变量（缺任一都会让用户"改了资料却看不到变化"或"每次都白算"）：
 *   ① 指纹不变 → 直接返回缓存对象（**同一个引用**，不重算）；
 *   ② 指纹变化 → 重算。关键在于**只改 sections.body、不动 cards.updated_at** 也必须变，
 *      因为真实写入路径里存在"卡记录没动、只改某一节正文"的情况
 *      —— 只 hash `updated_at` 会漏掉这类变更（T03 明确要求指纹含 sections.body）。
 */
import { describe, expect, it } from "vitest";
import { AbilitySnapshotCache } from "../src/ability/cache.js";
import { computeAbilityFingerprint, type AbilityStoreLike } from "../src/ability/extract.js";

const CARD_UPDATED_AT = "2026-11-01T00:00:00+08:00";

/** 可变的 store 桩：`setBody()` 只改正文，**刻意不动** card 的 updated_at。 */
function makeMutableStore(initialBody: string): {
  store: AbilityStoreLike;
  setBody(next: string): void;
} {
  let body = initialBody;
  let idSeq = 1;
  const store: AbilityStoreLike = {
    cards: {
      list: () =>
        [
          {
            key: "skills",
            title: "技能",
            summary: "",
            section_tags: [],
            updated_at: CARD_UPDATED_AT,
          },
        ] as never,
      get: () =>
        ({
          card: {
            key: "skills",
            title: "技能",
            summary: "",
            section_tags: [],
            updated_at: CARD_UPDATED_AT,
            schema_version: 1 as const,
          },
          sections: [
            {
              id: idSeq,
              card_key: "skills",
              title: "技能清单",
              body,
              ord: 0,
              updated_at: CARD_UPDATED_AT,
            },
          ],
        }) as never,
    },
  };
  return {
    store,
    setBody(next: string): void {
      body = next;
      idSeq += 0; // id 不变：模拟真实 UPDATE（不是删了重建）
    },
  };
}

describe("能力快照缓存", () => {
  it("① 指纹不变 → 命中缓存，返回同一对象且不重算", () => {
    const { store } = makeMutableStore("后端：Java、Spring Boot");
    const cache = new AbilitySnapshotCache();

    const first = cache.getSnapshot(store, { now: "2026-11-13T14:00:00+08:00" });
    const second = cache.getSnapshot(store, { now: "2026-11-13T15:00:00+08:00" });

    expect(second).toBe(first); // 同一引用 = 没重算
    expect(second.generated_at).toBe(first.generated_at); // 重算才会换时间
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(cache.stats().last_fingerprint).toBe(first.fingerprint);
  });

  it("② 只改 sections.body（cards.updated_at 不变）→ 指纹必须变并重算", () => {
    const { store, setBody } = makeMutableStore("后端：Java、Spring Boot");
    const cache = new AbilitySnapshotCache();
    const before = cache.getSnapshot(store, { now: "2026-11-13T14:00:00+08:00" });
    const fingerprintBefore = computeAbilityFingerprint(store);

    setBody("后端：Java、Spring Boot、Redis");

    const fingerprintAfter = computeAbilityFingerprint(store);
    expect(fingerprintAfter).not.toBe(fingerprintBefore);

    const after = cache.getSnapshot(store, { now: "2026-11-13T16:00:00+08:00" });
    expect(after).not.toBe(before);
    expect(after.fingerprint).toBe(fingerprintAfter);
    expect(after.nodes.map((n) => n.label)).toContain("Redis"); // 新内容生效
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("③ clear() 之后必须重算（即便指纹没变）", () => {
    const { store } = makeMutableStore("后端：Java");
    const cache = new AbilitySnapshotCache();
    const first = cache.getSnapshot(store, { now: "2026-11-13T14:00:00+08:00" });
    cache.clear();
    const second = cache.getSnapshot(store, { now: "2026-11-13T14:00:00+08:00" });
    expect(second).not.toBe(first);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("④ 指纹是 40 位 sha1，且随**节标题**变化（标题影响该不该抽）", () => {
    const { store } = makeMutableStore("后端：Java");
    const fingerprint = computeAbilityFingerprint(store);
    expect(fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });
});
