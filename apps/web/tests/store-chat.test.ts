/**
 * store-chat.test.ts — useChatStore 状态逻辑单元测试。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock uuid to return deterministic values
vi.mock("../src/lib/uuid", () => {
  let counter = 0;
  return {
    uuidv4: vi.fn(() => {
      counter++;
      const hex = counter.toString(16).padStart(12, "0");
      return `00000000-0000-0000-0000-${hex}`;
    }),
  };
});

import { useChatStore } from "../src/stores/chat";
import type { Transport } from "../src/transport/types";
import type { ConversationId, GetConversationResponse } from "@knowself/contracts";

function makeMockTransport(): Transport {
  return {
    chat: async function* () {
      // Empty — tests don't stream
    },
    abortChat: async () => ({ aborted: true }),
    listConversations: async () => ({ items: [], total: 0 }),
    getConversation: async () =>
      ({
        conversation: {
          id: "00000000-0000-0000-0000-000000000001" as ConversationId,
          title: "test",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          message_count: 0,
          last_provider_id: null,
        },
        messages: [],
      }) as GetConversationResponse,
    renameConversation: async () => ({
      id: "00000000-0000-0000-0000-000000000001" as ConversationId,
      title: "renamed",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_count: 0,
      last_provider_id: null,
    }),
    deleteConversation: async () => {},
    getCore: async () => ({
      display_name: "test",
      locale: "zh-CN",
      section_tags: [],
      body: "",
      updated_at: new Date().toISOString(),
      schema_version: 1 as const,
    }),
    saveCore: async () => {},
    listCards: async () => [],
    getCard: async () => ({
      key: "test_card" as never,
      title: "test",
      summary: "test",
      section_tags: [],
      updated_at: new Date().toISOString(),
      schema_version: 1 as const,
    }),
    saveCard: async () => {},
    appendCardSection: async () => {},
    listJournalDates: async () => [],
    getJournal: async () => ({
      date: "2026-01-01",
      records: [],
    }),
    appendJournal: async () => {},
    getSettings: async () => {
      const defaults = {
        enabled_globally: true,
        fetch_fallback_policy: {},
        per_template: { free_chat: true },
        system_prompt_addendum: "",
      };
      return {
        schema_version: 1 as const,
        app: {
          locale: "zh-CN" as const,
          theme: "system" as const,
          open_browser_on_start: true,
          server_port: 9527,
          feature_flags: {
            auto_writeback: true,
            system_status_page: true,
            debug_panel: false,
          },
        },
        conversation: {
          default_provider_id: "",
          default_tools_enabled: true,
          default_write_back: true,
          max_tool_iterations: 8,
          history_retention_days: 0,
          history_messages_per_conversation: 500,
          writeback_provider_id: "",
        },
        providers: [],
        mcp_servers: [],
        builtin_tools: [],
        tool_defaults: defaults,
        retrieval: {} as never,
        storage: {
          profile_dir: "profile",
          data_dir: "data",
          backup_enabled: false,
          backup_keep_days: 30,
        },
      };
    },
    patchSettings: async () => undefined as never,
    getSystemStatus: async () => undefined as never,
  };
}

describe("useChatStore", () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  it("初始状态为空", () => {
    const state = useChatStore.getState();
    expect(state.messages).toHaveLength(0);
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
  });

  it("startConversation 创建新会话 ID", () => {
    const id = useChatStore.getState().startConversation();
    expect(id).toBeTruthy();
    expect(useChatStore.getState().currentConversationId).toBe(id);
  });

  it("reset 清空所有状态", () => {
    useChatStore.getState().startConversation();
    useChatStore.getState().reset();
    const state = useChatStore.getState();
    expect(state.currentConversationId).toBeNull();
    expect(state.messages).toHaveLength(0);
  });

  it("loadConversation 设置 conversation ID", async () => {
    const t = makeMockTransport();
    const cid = "00000000-0000-0000-0000-000000000001" as ConversationId;
    await useChatStore.getState().loadConversation(cid, t);
    expect(useChatStore.getState().currentConversationId).toBe(cid);
  });
});
