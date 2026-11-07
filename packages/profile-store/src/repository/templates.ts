import type { TemplateRecord, TemplateVariable } from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ProfileNotFoundError } from "../errors";
import { parseJsonColumn, stringifyJsonColumn } from "../json";

function parseVariables(raw: string): TemplateVariable[] {
  return parseJsonColumn<TemplateVariable[]>(raw, []);
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  system_prompt_inject: string;
  variables: string;
  created_at: string;
}

function rowToRecord(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system_prompt_inject: row.system_prompt_inject,
    variables: parseVariables(row.variables),
    created_at: row.created_at,
  };
}

const BUILTINS: Array<{
  id: string;
  name: string;
  description: string;
  system_prompt_inject: string;
  variables: TemplateVariable[];
}> = [
  {
    id: "builtin-decision",
    name: "决策助手",
    description: "系统化分析决策，列出方案并权衡利弊",
    system_prompt_inject:
      "你是一位决策顾问。帮助用户系统化地分析决策问题，列出可选方案，权衡利弊，并给出建议。",
    variables: [
      { key: "决策主题", label: "你要决策什么？", type: "text", required: true },
      { key: "可选方案", label: "可选方案有哪些？", type: "textarea", required: true },
      { key: "约束条件", label: "有哪些约束条件？", type: "textarea", required: false },
    ],
  },
  {
    id: "builtin-review",
    name: "复盘模板",
    description: "对已完成事件进行结构化复盘分析",
    system_prompt_inject:
      "你是一位复盘教练。引导用户对已完成事件进行结构化复盘：回顾目标、评估结果、分析原因、总结规律。",
    variables: [
      { key: "复盘事件", label: "要复盘的事件是什么？", type: "text", required: true },
      { key: "预期目标", label: "原来的预期目标是什么？", type: "textarea", required: true },
      { key: "实际结果", label: "实际结果如何？", type: "textarea", required: true },
    ],
  },
  {
    id: "builtin-socratic",
    name: "深度提问",
    description: "苏格拉底式追问，帮助深入理解话题",
    system_prompt_inject:
      "你是一位苏格拉底式提问者。通过层层追问帮助用户深入理解某个话题，质疑假设，探索盲区。",
    variables: [
      { key: "话题", label: "想深入探讨什么话题？", type: "text", required: true },
      { key: "当前认知", label: "你当前对它的理解是什么？", type: "textarea", required: false },
    ],
  },
];

export function createTemplatesRepo(db: ProfileDb) {
  return {
    list(): TemplateRecord[] {
      const rows = db
        .prepare("SELECT * FROM templates ORDER BY created_at DESC")
        .all() as TemplateRow[];
      return rows.map(rowToRecord);
    },

    get(id: string): TemplateRecord {
      const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as
        | TemplateRow
        | undefined;
      if (!row) throw new ProfileNotFoundError(`模板不存在: ${id}`);
      return rowToRecord(row);
    },

    create(input: Omit<TemplateRecord, "created_at">): TemplateRecord {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO templates (id, name, description, system_prompt_inject, variables, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.description,
        input.system_prompt_inject,
        stringifyJsonColumn(input.variables),
        now,
      );
      return this.get(input.id);
    },

    delete(id: string): void {
      db.prepare("DELETE FROM templates WHERE id = ?").run(id);
    },

    seedBuiltins(): void {
      const count = (db.prepare("SELECT COUNT(*) as c FROM templates").get() as { c: number }).c;
      if (count > 0) return;
      const now = new Date().toISOString();
      const stmt = db.prepare(
        `INSERT INTO templates (id, name, description, system_prompt_inject, variables, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const t of BUILTINS) {
        stmt.run(
          t.id,
          t.name,
          t.description,
          t.system_prompt_inject,
          stringifyJsonColumn(t.variables),
          now,
        );
      }
    },
  };
}

export type TemplatesRepo = ReturnType<typeof createTemplatesRepo>;
