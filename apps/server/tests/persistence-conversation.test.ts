import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createConversationStore } from "../src/persistence/conversation";

describe("conversation store", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createConversationStore>;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_provider_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        turn_id TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);
    store = createConversationStore(db);
  });

  afterAll(() => db.close());

  it("ensures a conversation exists", () => {
    const id = randomUUID();
    store.ensureConversation(id, { title: "Test" });
    const conv = store.getConversation(id);
    expect(conv.conversation.title).toBe("Test");
    expect(conv.messages).toEqual([]);
  });

  it("appends messages to a conversation", () => {
    const convId = randomUUID();
    store.ensureConversation(convId, { title: "With messages" });
    store.appendMessage({
      id: randomUUID(),
      conversation_id: convId,
      role: "user",
      content: [{ kind: "text", text: "hello" }],
      created_at: new Date().toISOString(),
      provider_id: null,
      model: null,
    });
    const conv = store.getConversation(convId);
    expect(conv.messages.length).toBe(1);
    expect(conv.messages[0]!.role).toBe("user");
  });

  it("lists conversations", () => {
    const result = store.listConversations({ limit: 10, offset: 0 });
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(typeof result.total).toBe("number");
  });

  it("renames a conversation", () => {
    const id = randomUUID();
    store.ensureConversation(id, { title: "Old name" });
    store.renameConversation(id, "New name");
    const conv = store.getConversation(id);
    expect(conv.conversation.title).toBe("New name");
  });

  it("deletes a conversation", () => {
    const id = randomUUID();
    store.ensureConversation(id, { title: "To delete" });
    store.deleteConversation(id);
    expect(() => store.getConversation(id)).toThrow();
  });

  it("throws NOT_FOUND for missing conversation", () => {
    expect(() => store.getConversation(randomUUID())).toThrow();
  });
});
