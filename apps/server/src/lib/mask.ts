/**
 * mask.ts — 敏感字段掩码
 *
 * 纯函数，不修改传入对象。用在 GET /api/settings 序列化前。
 *
 * 屏蔽规则（见 api-routes.md §4.1）：
 *   - providers[].api_key → "***"
 *   - mcp_servers[].transport_config.env.* 名字含 KEY/TOKEN/SECRET → "***"
 *   - mcp_servers[].transport_config.auth_token → "***"
 *   - builtin_tools[].api_key → "***"
 */

import type {
  AppSettings,
  ProviderConfig,
  McpServerConfig,
  BuiltinToolConfig,
} from "@knowself/contracts";

const MASK = "***";

/** 掩码单个 api_key 字符串：保留前 5 字符，"sk-***" 格式 */
export function maskString(s: string): string {
  if (s.length <= 5) return MASK;
  return s.slice(0, 5) + MASK;
}

const SENSITIVE_KEY_PATTERN = /(KEY|TOKEN|SECRET)/i;

function maskRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = typeof v === "string" && v.length > 0 ? maskString(v) : MASK;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskProvider(p: ProviderConfig): ProviderConfig {
  return { ...p, api_key: p.api_key ? maskString(p.api_key) : p.api_key };
}

function maskMcpServer(s: McpServerConfig): McpServerConfig {
  const tc = s.transport_config;
  let maskedTc = tc as unknown as Record<string, unknown>;

  if (tc.transport === "stdio" && tc.env) {
    maskedTc = { ...maskedTc, env: maskRecord(tc.env as Record<string, unknown>) };
  }
  if (tc.transport === "streamable_http") {
    if (
      "auth_token" in maskedTc &&
      typeof maskedTc.auth_token === "string" &&
      maskedTc.auth_token
    ) {
      maskedTc = { ...maskedTc, auth_token: maskString(maskedTc.auth_token) };
    }
    if (maskedTc.headers && typeof maskedTc.headers === "object") {
      maskedTc = {
        ...maskedTc,
        headers: maskRecord(maskedTc.headers as Record<string, unknown>),
      };
    }
  }

  return {
    ...s,
    transport_config: maskedTc as typeof s.transport_config,
  };
}

function maskBuiltinTool(t: BuiltinToolConfig): BuiltinToolConfig {
  return { ...t, api_key: t.api_key ? maskString(t.api_key) : t.api_key };
}

/**
 * 对传入的 AppSettings 做深拷贝掩码；不修改原对象。
 * 实现覆盖全部敏感字段。
 */
export function maskSettings(s: AppSettings): AppSettings {
  return {
    ...s,
    providers: s.providers.map(maskProvider),
    mcp_servers: s.mcp_servers.map(maskMcpServer),
    builtin_tools: s.builtin_tools.map(maskBuiltinTool),
  };
}
