import { create } from "zustand";
import type { TemplateRecord, TemplatePromptResponse } from "@knowself/contracts";
import type { Transport } from "../transport/types";

interface TemplateStore {
  templates: TemplateRecord[];
  loading: boolean;
  fetchTemplates: (t: Transport) => Promise<void>;
  createTemplate: (
    input: Omit<TemplateRecord, "created_at">,
    t: Transport,
  ) => Promise<TemplateRecord>;
  deleteTemplate: (id: string, t: Transport) => Promise<void>;
  buildPrompt: (
    templateId: string,
    variableValues: Record<string, string>,
    userMessage: string,
    t: Transport,
  ) => Promise<TemplatePromptResponse>;
}

export const useTemplateStore = create<TemplateStore>((set, _get) => ({
  templates: [],
  loading: false,

  async fetchTemplates(t: Transport) {
    set({ loading: true });
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const templates: TemplateRecord[] = await t.listTemplates();
      set({ templates });
    } finally {
      set({ loading: false });
    }
  },

  async createTemplate(input: Omit<TemplateRecord, "created_at">, t: Transport) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const created: TemplateRecord = await t.createTemplate(input);
    set((s) => ({ templates: [...s.templates, created] }));
    return created;
  },

  async deleteTemplate(id, t) {
    await t.deleteTemplate(id);
    set((s) => ({ templates: s.templates.filter((tpl) => tpl.id !== id) }));
  },

  async buildPrompt(templateId, variableValues, userMessage, t) {
    return t.buildPrompt({
      template_id: templateId,
      variable_values: variableValues,
      user_message: userMessage,
    });
  },
}));
