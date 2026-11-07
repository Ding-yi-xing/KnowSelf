import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { createRuntime } from "../src/runtime";
import type { Runtime } from "../src/runtime";
import { profileRoutes } from "../src/routes/profile";
import { onError } from "../src/middleware/error";

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.onError(onError);
  app.route("/api/profile", profileRoutes(runtime));
  return app;
}

describe("profile routes", () => {
  let db: Database.Database;
  let runtime: Runtime;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE core_profile (id INTEGER PRIMARY KEY, display_name TEXT, locale TEXT, section_tags TEXT, body TEXT, updated_at TEXT, schema_version INTEGER);
      CREATE TABLE cards (key TEXT PRIMARY KEY, title TEXT, summary TEXT, section_tags TEXT, updated_at TEXT, schema_version INTEGER);
      CREATE TABLE card_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, card_key TEXT, title TEXT, body TEXT, ord INTEGER, updated_at TEXT);
      CREATE TABLE journal_records (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, ordinal INTEGER, recorded_at TEXT, provenance TEXT, tags TEXT, body TEXT);
      INSERT INTO core_profile (id, display_name, locale, section_tags, body, updated_at, schema_version) VALUES (1, 'Test', 'zh-CN', '[]', 'Hello', '2026-01-01T00:00:00.000Z', 1);
    `);

    const cardData: Record<
      string,
      { card: Record<string, unknown>; sections: Array<Record<string, unknown>> }
    > = {
      work: {
        card: {
          key: "work",
          title: "Work",
          summary: "My work",
          section_tags: [],
          updated_at: "2026-01-01T00:00:00.000Z",
          schema_version: 1,
        },
        sections: [],
      },
    };

    const profileStore = {
      core: {
        get: () => ({
          display_name: "Test",
          locale: "zh-CN",
          section_tags: [] as string[],
          body: "Hello",
          updated_at: "2026-01-01T00:00:00.000Z",
          schema_version: 1 as const,
        }),
        save: () => {},
      },
      cards: {
        list: () => [
          {
            key: "work",
            title: "Work",
            summary: "My work",
            section_tags: [] as string[],
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        get: (key: string) => {
          if (cardData[key]) return cardData[key];
          const err = new Error("Not found") as Error & { code: string };
          err.code = "PROFILE_NOT_FOUND";
          throw err;
        },
        save: () => {},
        appendSection: () => {},
        delete: () => {},
      },
      journal: {
        listDates: () => [
          { date: "2026-01-01", record_count: 0, updated_at: "2026-01-01T00:00:00.000Z" },
        ],
        get: (date: string) => ({ date, records: [] }),
        append: () => ({
          id: 1,
          date: "2026-01-01",
          ordinal: 1,
          recorded_at: "2026-01-01T00:00:00.000Z",
          provenance: "user" as const,
          tags: [] as string[],
          body: "test",
        }),
      },
      sources: {
        list: () => ({ items: [], total: 0 }),
        get: () => ({
          id: "",
          kind: "file" as const,
          mime_type: "text/plain" as const,
          original_name: "",
          file_path: null,
          url: null,
          extracted_text: "",
          truncated: false,
          char_count: 0,
          user_note: "",
          user_tags: [],
          status: "raw" as const,
          metadata: {},
          created_at: "",
          last_ingested_at: null,
        }),
        updateStatus: () => {},
        updateNote: () => {},
        delete: () => {},
        insert: () => {},
      },
      links: {
        listForProfile: () => ({ links: [], sources: [] }),
        listForSource: () => [],
        insert: () => {},
      },
      events: { on: () => () => {}, emit: () => {} },
      write: (_req: unknown, _ctx: unknown) => {},
      exportProfile: async () => ({
        download_path: "export-test.zip",
        format: "json" as const,
        size_bytes: 100,
        generated_at: "2026-01-01T00:00:00.000Z",
      }),
      close: () => {},
    };

    runtime = createRuntime({
      profileStore: profileStore as Runtime["profileStore"],
      paths: { exportsDir: "/tmp/exports" } as Runtime["paths"],
    });
  });

  afterAll(() => db.close());

  it("GET /api/profile/core returns profile", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/core");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.display_name).toBe("Test");
  });

  it("GET /api/profile/core 在 core_profile 未初始化时返回默认空对象 + 200(不是 404)", async () => {
    // 用一个会抛 PROFILE_NOT_FOUND 的 store 替身
    const uninitProfileStore = {
      ...(runtime.profileStore as unknown as Record<string, unknown>),
      core: {
        get: () => {
          const err = new Error("core_profile 尚未初始化") as Error & { code: string };
          err.code = "PROFILE_NOT_FOUND";
          throw err;
        },
        save: () => {},
      },
    };
    const uninitRuntime = createRuntime({
      profileStore: uninitProfileStore as unknown as Runtime["profileStore"],
      paths: runtime.paths,
      settings: { app: { locale: "zh-CN" } } as unknown as Runtime["settings"],
    });
    const app = makeApp(uninitRuntime);
    const res = await app.request("/api/profile/core");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.display_name).toBe("我");
    expect(body.locale).toBe("zh-CN");
    expect(body.body).toBe("");
    expect(body.section_tags).toEqual([]);
    expect(body.schema_version).toBe(1);
    expect(typeof body.updated_at).toBe("string");
  });

  it("PUT /api/profile/core with valid WriteRequest updates profile", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/core", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "core", body: "Updated", provenance: "user" }),
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/profile/cards returns list", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/cards");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET /api/profile/cards/work returns card", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/cards/work");
    expect(res.status).toBe(200);
  });

  it("GET /api/profile/cards/unknown returns 404", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/cards/unknown");
    expect(res.status).toBe(404);
  });

  it("GET /api/profile/journal returns list", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/journal");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("POST /api/profile/export returns export info", async () => {
    const app = makeApp(runtime);
    const res = await app.request("/api/profile/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json", include_sources: false }),
    });
    expect(res.status).toBe(200);
  });
});
