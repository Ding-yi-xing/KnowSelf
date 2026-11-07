import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { TemplateRecord } from "@knowself/contracts";
import { templateRoutes } from "../src/routes/templates";
import type { Runtime } from "../src/runtime";

function makeApp(runtime: Runtime) {
  const app = new Hono();
  app.route("/api/templates", templateRoutes(runtime));
  return app;
}

const decisionTemplate: TemplateRecord = {
  id: "builtin-decision",
  name: "决策助手",
  description: "系统化分析决策，列出方案并权衡利弊",
  system_prompt_inject: "你是一位决策顾问。",
  variables: [
    { key: "topic", label: "你要决策什么？", type: "text", required: true },
    { key: "options", label: "可选方案有哪些？", type: "textarea", required: true },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("template routes", () => {
  it("build-prompt creates a usable user message when request user_message is empty", async () => {
    const app = makeApp({
      profileStore: {
        templates: {
          list: () => [decisionTemplate],
          get: () => decisionTemplate,
          create: () => decisionTemplate,
          delete: () => {},
          seedBuiltins: () => {},
        },
      },
    } as Runtime);

    const res = await app.request("/api/templates/build-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "builtin-decision",
        variable_values: {
          topic: "是否换工作",
          options: "继续当前工作 / 接受新 offer",
        },
        user_message: "",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { system_prompt: string; user_message: string };
    expect(body.system_prompt).toBe("你是一位决策顾问。");
    expect(body.user_message).toContain("请使用「决策助手」模板帮助我。");
    expect(body.user_message).toContain("你要决策什么？: 是否换工作");
    expect(body.user_message).toContain("可选方案有哪些？: 继续当前工作 / 接受新 offer");
  });
});
