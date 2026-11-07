import { Hono } from "hono";
import type { Context } from "hono";
import type { Runtime } from "../runtime";
import { zValidate } from "../middleware/validate";
import {
  TemplatePromptRequest,
  TemplateCreateRequest,
  type TemplateRecord,
} from "@knowself/contracts";

export function templateRoutes(runtime: Runtime): Hono {
  const router = new Hono();

  router.get("/", (_c: Context) => {
    return Response.json(runtime.profileStore.templates.list());
  });

  router.post("/", zValidate(TemplateCreateRequest, "json"), (c: Context) => {
    const req = c.get("validated") as Parameters<typeof runtime.profileStore.templates.create>[0];
    const result = runtime.profileStore.templates.create(req);
    return c.json(result, 201 as never);
  });

  router.delete("/:id", (c: Context) => {
    const id = c.req.param("id")!;
    if (id.startsWith("builtin-")) {
      return c.json({ code: "VALIDATION", message: "内置模板不可删除" }, 422 as never);
    }
    runtime.profileStore.templates.delete(id);
    return c.json({ ok: true });
  });

  router.post("/build-prompt", zValidate(TemplatePromptRequest, "json"), (c: Context) => {
    const req = c.get("validated") as {
      template_id: string;
      variable_values: Record<string, string>;
      user_message: string;
    };
    let tmpl;
    try {
      tmpl = runtime.profileStore.templates.get(req.template_id);
    } catch {
      return c.json({ code: "TEMPLATE_NOT_FOUND", message: "模板不存在" }, 404 as never);
    }

    for (const v of tmpl.variables) {
      if (v.required && !req.variable_values[v.key]) {
        return c.json(
          { code: "VARIABLE_REQUIRED", message: `缺少必填变量: ${v.label}` },
          422 as never,
        );
      }
    }

    let system_prompt = tmpl.system_prompt_inject;
    let user_message =
      req.user_message.trim() || buildDefaultUserMessage(tmpl, req.variable_values);
    for (const v of tmpl.variables) {
      const val = req.variable_values[v.key] ?? "";
      if (!val) continue;
      const pattern = new RegExp(`\\{\\{${v.key}\\}\\}`, "g");
      system_prompt = system_prompt.replace(pattern, val);
      user_message = user_message.replace(pattern, val);
    }

    return c.json({ system_prompt, user_message });
  });

  return router;
}

function buildDefaultUserMessage(
  tmpl: TemplateRecord,
  variableValues: Record<string, string>,
): string {
  const lines = [`请使用「${tmpl.name}」模板帮助我。`];
  const description = tmpl.description.trim();
  if (description) {
    lines.push(`模板说明：${description}`);
  }

  const filledVariables = tmpl.variables
    .map((v) => {
      const label = v.label || v.key;
      const value = (variableValues[v.key] ?? "").trim();
      return value ? `- ${label}: ${value}` : null;
    })
    .filter((line): line is string => Boolean(line));

  if (filledVariables.length > 0) {
    lines.push("我填写的信息：", ...filledVariables);
  }
  lines.push("请基于以上信息直接开始。");

  return lines.join("\n");
}
