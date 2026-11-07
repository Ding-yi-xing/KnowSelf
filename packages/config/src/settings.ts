import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppSettingsSchema, type AppSettings, type PartialAppSettings } from "@knowself/contracts";
import { ZodError } from "zod";
import {
  SettingsParseError,
  SettingsValidationError,
  SettingsWriteError,
  SettingsReferenceError,
  SettingsVersionError,
} from "./errors";

const SETTINGS_FILENAME = "settings.json";

function resolveSettingsPath(rootDir: string): string {
  return join(rootDir, SETTINGS_FILENAME);
}

/** 读盘 + JSON.parse + Zod parse。任一失败都抛对应 SettingsError。 */
export function loadSettings(rootDir: string): AppSettings {
  const filePath = resolveSettingsPath(rootDir);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new SettingsParseError("settings.json 不存在或不可读", filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsParseError("settings.json 不是合法 JSON", filePath);
  }

  try {
    return AppSettingsSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = first ? first.path.join(".") : undefined;
      throw new SettingsValidationError(
        `settings.json 校验失败${path ? `：${path} ${first?.message}` : ""}`,
        filePath,
      );
    }
    throw err;
  }
}

function pickDefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 合并 partial patch → validate → reference check → atomic write。 */
export function saveSettings(rootDir: string, patch: PartialAppSettings): AppSettings {
  const current = loadSettings(rootDir);

  // Merge each section: only override keys explicitly present in patch.
  // Use a helper to avoid exactOptionalPropertyTypes issues with spread.
  const app = patch.app ? { ...current.app, ...pickDefined(patch.app) } : current.app;
  const conversation = patch.conversation
    ? { ...current.conversation, ...pickDefined(patch.conversation) }
    : current.conversation;
  const storage = patch.storage
    ? { ...current.storage, ...pickDefined(patch.storage) }
    : current.storage;

  const merged: AppSettings = {
    schema_version: 1,
    app: app,
    conversation: conversation,
    providers: patch.providers ?? current.providers,
    mcp_servers: patch.mcp_servers ?? current.mcp_servers,
    builtin_tools: patch.builtin_tools ?? current.builtin_tools,
    tool_defaults: patch.tool_defaults ?? current.tool_defaults,
    retrieval: patch.retrieval ?? current.retrieval,
    storage: storage,
  };

  try {
    AppSettingsSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const path = first ? first.path.join(".") : undefined;
      throw new SettingsValidationError(
        `合并后 settings 校验失败${path ? `：${path} ${first?.message}` : ""}`,
      );
    }
    throw err;
  }

  checkReferences(merged);

  const filePath = resolveSettingsPath(rootDir);
  const tmpPath = join(dirname(filePath), `.settings-${randomUUID()}.tmp`);

  try {
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw new SettingsWriteError(`settings.json 写盘失败: ${String(err)}`, filePath);
  }

  return merged;
}

// ──────────────────────────────────────────────────
//  Reference consistency checks (per contracts/settings.ts)
// ──────────────────────────────────────────────────

function checkReferences(s: AppSettings): void {
  const providerIds = new Set(s.providers.map((p) => p.id));
  const mcpIds = new Set(s.mcp_servers.map((m) => m.id));

  // 1. default_provider_id must exist
  if (s.conversation.default_provider_id && !providerIds.has(s.conversation.default_provider_id)) {
    throw new SettingsReferenceError(
      `conversation.default_provider_id "${s.conversation.default_provider_id}" 不存在于 providers 列表`,
      "conversation.default_provider_id",
    );
  }

  // 2. Same purpose at most one default_for
  const purposeDefaults = new Map<string, string[]>();
  for (const p of s.providers) {
    for (const purpose of p.default_for ?? []) {
      const existing = purposeDefaults.get(purpose) ?? [];
      existing.push(p.id);
      purposeDefaults.set(purpose, existing);
    }
  }
  for (const [purpose, ids] of purposeDefaults) {
    if (ids.length > 1) {
      throw new SettingsReferenceError(
        `ProviderPurpose "${purpose}" 有多个 default_for: [${ids.join(", ")}]`,
        `providers.default_for.${purpose}`,
      );
    }
  }

  // 3. retrieval rerank/classifier provider must exist
  const retrieval = s.retrieval as Record<string, unknown>;
  if (retrieval.rerank_provider_id && !providerIds.has(retrieval.rerank_provider_id as string)) {
    throw new SettingsReferenceError(
      `retrieval.rerank_provider_id "${retrieval.rerank_provider_id}" 不存在于 providers 列表`,
      "retrieval.rerank_provider_id",
    );
  }
  if (
    retrieval.classifier_provider_id &&
    !providerIds.has(retrieval.classifier_provider_id as string)
  ) {
    throw new SettingsReferenceError(
      `retrieval.classifier_provider_id "${retrieval.classifier_provider_id}" 不存在于 providers 列表`,
      "retrieval.classifier_provider_id",
    );
  }

  // 4. fetch fallback source IDs must exist in mcp_servers
  const toolDefaults = s.tool_defaults as Record<string, unknown>;
  const ffp = toolDefaults.fetch_fallback_policy as Record<string, unknown> | undefined;
  if (ffp?.enabled) {
    if (ffp.primary_source_id && !mcpIds.has(ffp.primary_source_id as string)) {
      throw new SettingsReferenceError(
        `tool_defaults.fetch_fallback_policy.primary_source_id "${ffp.primary_source_id}" 不存在于 mcp_servers 列表`,
        "tool_defaults.fetch_fallback_policy.primary_source_id",
      );
    }
    if (ffp.fallback_source_id && !mcpIds.has(ffp.fallback_source_id as string)) {
      throw new SettingsReferenceError(
        `tool_defaults.fetch_fallback_policy.fallback_source_id "${ffp.fallback_source_id}" 不存在于 mcp_servers 列表`,
        "tool_defaults.fetch_fallback_policy.fallback_source_id",
      );
    }
  }

  // 5. schema_version must be 1
  if (s.schema_version !== 1) {
    throw new SettingsVersionError(
      `schema_version ${s.schema_version} 与当前代码不兼容（仅支持 1）`,
      "schema_version",
    );
  }
}
