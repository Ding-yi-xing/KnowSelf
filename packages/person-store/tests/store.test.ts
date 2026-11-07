import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createPersonStore, type PersonStore } from "../src/store";
import { normalizeAlias } from "../src/identity";
import { makeTempDir, removeTempDir } from "./helpers";

const NOW = "2026-09-10T10:00:00+08:00";
const LATER = "2026-09-10T11:00:00+08:00";

let dir: string;
let store: PersonStore;

beforeEach(() => {
  dir = makeTempDir();
  store = createPersonStore({ dbPath: join(dir, "persons.sqlite"), encryption: { mode: "none" } });
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

describe("createPersonStore — 门面", () => {
  it("装配 persons / aliases，'me' 已 seed，getMeta 可读约定键", () => {
    expect(store.getPerson("missing")).toBeNull();
    expect(store.getPerson("me")?.subject_kind).toBe("self");
    expect(store.listPersons().map((r) => r.person_id)).toEqual(["me"]);
    expect(store.getMeta("timezone")).toBe("Asia/Shanghai");
    expect(store.getMeta("nope")).toBeUndefined();
  });

  it("transaction 提交与回滚", () => {
    store.transaction(() => {
      store.persons.insert({ person_id: "p1", subject_kind: "contact", display_name: "p1" }, NOW);
    });
    expect(store.getPerson("p1")).not.toBeNull();
    expect(() =>
      store.transaction(() => {
        store.persons.insert({ person_id: "p2", subject_kind: "contact", display_name: "p2" }, NOW);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getPerson("p2")).toBeNull();
  });

  it("listPersons 透传过滤条件", () => {
    store.persons.insert({ person_id: "p1", subject_kind: "contact", display_name: "张三" }, NOW);
    expect(store.listPersons({ keyword: "张" }).map((r) => r.person_id)).toEqual(["p1"]);
    expect(store.listPersons({ subject_kind: "contact" }).length).toBe(1);
  });
});

describe("store.ensurePersonForUid", () => {
  it("首次：建 contact 人物 + platform_uid 别名（extractor / confidence=1.0 / is_primary）", () => {
    const result = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "张三",
      now: NOW,
    });
    expect(result.created).toBe(true);
    const person = store.getPerson(result.person_id);
    expect(person?.subject_kind).toBe("contact");
    expect(person?.display_name).toBe("张三");
    const alias = store.aliases.findByUid("wechat", "wxid_1");
    expect(alias?.person_id).toBe(result.person_id);
    expect(alias?.alias_kind).toBe("platform_uid");
    expect(alias?.source).toBe("extractor");
    expect(alias?.confidence).toBe(1.0);
    expect(alias?.is_primary).toBe(true);
    expect(alias?.normalized).toBe("wxid_1");
  });

  it("二次调用：复用既有 person_id，不覆盖 display_name（FR-8.6）", () => {
    const first = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "张三",
      now: NOW,
    });
    const second = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "采集到的新名字",
      now: LATER,
    });
    expect(second).toEqual({ person_id: first.person_id, created: false });
    expect(store.getPerson(first.person_id)?.display_name).toBe("张三");
    expect(store.aliases.listByPerson(first.person_id).length).toBe(1);
  });

  it("伪 ID：alias='name:<normalized>'、confidence=0.6（DESIGN-11 §4.5）", () => {
    const result = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "name:张三",
      display_name: "张三",
      confidence: 0.6,
      now: NOW,
    });
    const alias = store.aliases.findByUid("wechat", "name:张三");
    expect(alias?.person_id).toBe(result.person_id);
    expect(alias?.confidence).toBe(0.6);
    expect(alias?.alias_kind).toBe("platform_uid");
    expect(
      store.ensurePersonForUid({
        platform: "wechat",
        platform_uid: "name:张三",
        display_name: "张三",
        confidence: 0.6,
        now: LATER,
      }).created,
    ).toBe(false);
  });

  it("归一化：去空白 / 去 emoji / 小写", () => {
    expect(normalizeAlias(" 老 王 ")).toBe("老王");
    expect(normalizeAlias("Alice")).toBe("alice");
    expect(normalizeAlias("王🙂二")).toBe("王二");
    store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "Name: Alice",
      display_name: "Alice",
      now: NOW,
    });
    expect(store.aliases.findByUid("wechat", "Name: Alice")?.normalized).toBe("name:alice");
  });

  it("跨重启幂等：重开同一库，同一 uid 仍解析到同一 person_id", () => {
    const first = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "张三",
      now: NOW,
    });
    store.close();
    store = createPersonStore({
      dbPath: join(dir, "persons.sqlite"),
      encryption: { mode: "none" },
    });
    const again = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "张三",
      now: LATER,
    });
    expect(again).toEqual({ person_id: first.person_id, created: false });
  });

  it("不同平台同一 display_name 建两个人物（同名 ≠ 同人）", () => {
    const a = store.ensurePersonForUid({
      platform: "wechat",
      platform_uid: "wxid_1",
      display_name: "老王",
      now: NOW,
    });
    const b = store.ensurePersonForUid({
      platform: "qq",
      platform_uid: "qq_1",
      display_name: "老王",
      now: NOW,
    });
    expect(a.person_id).not.toBe(b.person_id);
    expect(store.listPersons({ subject_kind: "contact" }).length).toBe(2);
  });
});
