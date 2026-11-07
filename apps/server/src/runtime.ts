import type Database from "better-sqlite3";
import type { AppSettings } from "@knowself/contracts";
import type { DataPaths } from "@knowself/config";
import type { ProfileStore } from "@knowself/profile-store";
import type { McpHost } from "@knowself/mcp-host";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import type { Ingestion } from "@knowself/ingestion";
import type { ContextRouter } from "@knowself/context-router";
import type { PersonStore } from "@knowself/person-store";
import type { ConversationStore } from "./persistence/conversation";
import type { AbortRegistry } from "./lib/abort";

export interface ShutdownItem {
  name: string;
  fn: () => Promise<void>;
}

export interface Runtime {
  settings: AppSettings;
  paths: DataPaths;
  profileStore: ProfileStore;
  conversationStore: ConversationStore;
  mcpHost: McpHost;
  providerAdapter: ProviderAdapter;
  ingestion: Ingestion;
  contextRouter: ContextRouter;
  abortRegistry: AbortRegistry;
  /** 多主体档案主存（persons.sqlite）；mining 只读路由的数据源（DESIGN-12 §8.5）。 */
  personStore: PersonStore;
  conversationsDb: Database.Database;
  profileDb: Database.Database;
  shutdownItems: ShutdownItem[];
}

export function createRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    settings: {} as AppSettings,
    paths: {} as DataPaths,
    profileStore: {} as ProfileStore,
    conversationStore: {} as ConversationStore,
    mcpHost: {} as McpHost,
    providerAdapter: {} as ProviderAdapter,
    ingestion: {} as Ingestion,
    contextRouter: {} as ContextRouter,
    abortRegistry: {} as AbortRegistry,
    personStore: {} as PersonStore,
    conversationsDb: {} as Database.Database,
    profileDb: {} as Database.Database,
    shutdownItems: [],
    ...overrides,
  };
}
