import { create } from "zustand";
import type { AppSettings, PartialAppSettings } from "@knowself/contracts";
import type { TransportError } from "../transport/types";
import type { useTransport } from "./transport-context";

interface SettingsState {
  settings: AppSettings | null;
  dirty: PartialAppSettings;
  saving: boolean;
  error: TransportError | null;

  load: (t: ReturnType<typeof useTransport>) => Promise<void>;
  patch: (diff: PartialAppSettings) => void;
  save: (t: ReturnType<typeof useTransport>) => Promise<void>;
  revert: () => void;
}

/**
 * 将 dirty 浅层合并到当前 settings 之上，产出一个完整的 AppSettings 用于 preview 或暂存。
 * 仅内部使用。
 */
function mergeDirty(settings: AppSettings, dirty: PartialAppSettings): AppSettings {
  const app = dirty.app
    ? ({ ...settings.app, ...pickDefined(dirty.app) } as typeof settings.app)
    : settings.app;
  const conversation = dirty.conversation
    ? ({
        ...settings.conversation,
        ...pickDefined(dirty.conversation),
      } as typeof settings.conversation)
    : settings.conversation;
  const storage = dirty.storage
    ? ({ ...settings.storage, ...pickDefined(dirty.storage) } as typeof settings.storage)
    : settings.storage;

  return {
    schema_version: settings.schema_version,
    app,
    conversation,
    providers: dirty.providers ?? settings.providers,
    mcp_servers: dirty.mcp_servers ?? settings.mcp_servers,
    builtin_tools: dirty.builtin_tools ?? settings.builtin_tools,
    tool_defaults: dirty.tool_defaults ?? settings.tool_defaults,
    retrieval: dirty.retrieval ?? settings.retrieval,
    storage,
  };
}

/** Return a new object with only the keys whose values are not undefined. */
function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  dirty: {},
  saving: false,
  error: null,

  load: async (t) => {
    set({ error: null });
    try {
      const settings = await t.getSettings();
      set({ settings, dirty: {} });
    } catch (err) {
      set({ error: err as TransportError });
    }
  },

  patch: (diff: PartialAppSettings) => {
    const current = get().dirty;
    const merged: PartialAppSettings = { ...current };

    if (diff.app) {
      merged.app = { ...(merged.app ?? {}), ...diff.app };
    }
    if (diff.conversation) {
      merged.conversation = {
        ...(merged.conversation ?? {}),
        ...diff.conversation,
      };
    }
    if (diff.providers !== undefined) {
      merged.providers = diff.providers;
    }
    if (diff.mcp_servers !== undefined) {
      merged.mcp_servers = diff.mcp_servers;
    }
    if (diff.builtin_tools !== undefined) {
      merged.builtin_tools = diff.builtin_tools;
    }
    if (diff.tool_defaults) {
      merged.tool_defaults = diff.tool_defaults;
    }
    if (diff.retrieval) {
      merged.retrieval = diff.retrieval;
    }
    if (diff.storage) {
      merged.storage = { ...(merged.storage ?? {}), ...diff.storage };
    }

    set({ dirty: merged });
  },

  save: async (t) => {
    const { dirty } = get();
    set({ saving: true, error: null });
    try {
      const updated = await t.patchSettings(dirty);
      set({ settings: updated, dirty: {}, saving: false });
    } catch (err) {
      set({ error: err as TransportError, saving: false });
    }
  },

  revert: () => {
    set({ dirty: {} });
  },
}));

/** 合并 dirty 到 settings 用于 UI 预览（不修改 store）。 */
export function useSettingsPreview(): AppSettings | null {
  const { settings, dirty } = useSettingsStore();
  if (!settings) return null;
  if (Object.keys(dirty).length === 0) return settings;
  return mergeDirty(settings, dirty);
}
