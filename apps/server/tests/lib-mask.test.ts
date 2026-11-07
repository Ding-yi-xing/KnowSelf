import { describe, it, expect } from "vitest";
import { maskString, maskSettings } from "../src/lib/mask";
import type {
  AppSettings,
  ProviderConfig,
  McpServerConfig,
  BuiltinToolConfig,
} from "@knowself/contracts";

describe("maskString", () => {
  it("长度 ≤ 5 返回 '***'", () => {
    expect(maskString("abc")).toBe("***");
    expect(maskString("12345")).toBe("***");
  });

  it("长度 > 5 返回前 5 字符 + '***'", () => {
    expect(maskString("sk-1234567890")).toBe("sk-12***");
  });
});

describe("maskSettings", () => {
  it("不修改原对象（深拷贝）", () => {
    const input = { providers: [], mcp_servers: [], builtin_tools: [] } as unknown as AppSettings;
    const output = maskSettings(input);
    expect(output).not.toBe(input);
  });

  it("providers[].api_key 被掩码", () => {
    const input = {
      providers: [{ api_key: "sk-secret-xxx" } as ProviderConfig],
      mcp_servers: [],
      builtin_tools: [],
    } as unknown as AppSettings;
    const output = maskSettings(input);
    expect(output.providers[0].api_key).toBe("sk-se***");
  });

  it("providers[].api_key 为空字符串保持空字符串", () => {
    const input = {
      providers: [{ api_key: "" } as ProviderConfig],
      mcp_servers: [],
      builtin_tools: [],
    } as unknown as AppSettings;
    const output = maskSettings(input);
    expect(output.providers[0].api_key).toBe("");
  });

  it("mcp_servers stdio 类型 env 中含 KEY/TOKEN/SECRET 的键被掩码，其它键保留", () => {
    const input = {
      providers: [],
      mcp_servers: [
        {
          transport_config: {
            transport: "stdio",
            env: {
              API_KEY: "secret",
              MY_TOKEN: "my-secret-token-value",
              OTHER: "keep",
              NORMAL: "stay",
            },
          },
        } as unknown as McpServerConfig,
      ],
      builtin_tools: [],
    } as unknown as AppSettings;
    const output = maskSettings(input);
    const env = (output.mcp_servers[0].transport_config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.API_KEY).toBe("secre***");
    expect(env.MY_TOKEN).toBe("my-se***");
    expect(env.OTHER).toBe("keep");
    expect(env.NORMAL).toBe("stay");
  });

  it("mcp_servers streamable_http 类型 auth_token 被掩码", () => {
    const input = {
      providers: [],
      mcp_servers: [
        {
          transport_config: {
            transport: "streamable_http",
            auth_token: "super-secret-token",
          },
        } as unknown as McpServerConfig,
      ],
      builtin_tools: [],
    } as unknown as AppSettings;
    const output = maskSettings(input);
    const tc = output.mcp_servers[0].transport_config as Record<string, unknown>;
    expect(tc.auth_token).toBe("super***");
  });

  it("builtin_tools[].api_key 被掩码", () => {
    const input = {
      providers: [],
      mcp_servers: [],
      builtin_tools: [{ api_key: "bt-key-123" } as BuiltinToolConfig],
    } as unknown as AppSettings;
    const output = maskSettings(input);
    expect(output.builtin_tools[0].api_key).toBe("bt-ke***");
  });
});
