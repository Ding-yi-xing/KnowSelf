import { z } from "zod";

export const TemplateVariable = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select"]),
  required: z.boolean().default(true),
  options: z.array(z.string()).optional(),
});
export const TemplateRecord = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  system_prompt_inject: z.string(),
  variables: z.array(TemplateVariable).default([]),
  created_at: z.string(),
});

/** 创建模板请求：无需传 created_at，由后端生成。 */
export const TemplateCreateRequest = TemplateRecord.omit({ created_at: true });
export const TemplatePromptRequest = z.object({
  template_id: z.string(),
  variable_values: z.record(z.string(), z.string()),
  user_message: z.string(),
});
export const TemplatePromptResponse = z.object({
  system_prompt: z.string(),
  user_message: z.string(),
});
export const TemplateErrorCode = z.enum([
  "TEMPLATE_NOT_FOUND",
  "VARIABLE_REQUIRED",
  "VARIABLE_INVALID",
]);

export type TemplateVariable = z.infer<typeof TemplateVariable>;
export type TemplateRecord = z.infer<typeof TemplateRecord>;
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequest>;
export type TemplatePromptRequest = z.infer<typeof TemplatePromptRequest>;
export type TemplatePromptResponse = z.infer<typeof TemplatePromptResponse>;
