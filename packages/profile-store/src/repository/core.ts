import type { CoreProfileStored, CoreProfileInput } from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ProfileNotFoundError } from "../errors";
import { parseJsonColumn, stringifyJsonColumn } from "../json";

interface CoreRow {
  id: number;
  display_name: string;
  locale: string;
  section_tags: string;
  body: string;
  updated_at: string;
  schema_version: number;
}

function rowToStored(row: CoreRow): CoreProfileStored {
  return {
    display_name: row.display_name,
    locale: row.locale,
    section_tags: parseJsonColumn<string[]>(row.section_tags, []),
    body: row.body,
    updated_at: row.updated_at,
    schema_version: 1 as const,
  };
}

export function createCoreRepo(db: ProfileDb) {
  return {
    get(): CoreProfileStored {
      const row = db.prepare("SELECT * FROM core_profile WHERE id = 1").get() as
        | CoreRow
        | undefined;
      if (!row) {
        throw new ProfileNotFoundError("core_profile 尚未初始化");
      }
      return rowToStored(row);
    },

    save(input: CoreProfileInput, now: string): void {
      let current: CoreProfileStored;
      try {
        current = this.get();
      } catch {
        current = {
          display_name: input.display_name ?? "",
          locale: input.locale ?? "zh-CN",
          section_tags: input.section_tags ?? [],
          body: input.body,
          updated_at: now,
          schema_version: 1 as const,
        };
      }

      const display_name = input.display_name ?? current.display_name;
      const locale = input.locale ?? current.locale;
      const section_tags = input.section_tags ?? current.section_tags;

      db.prepare(
        `INSERT OR REPLACE INTO core_profile
         (id, display_name, locale, section_tags, body, updated_at, schema_version)
         VALUES (1, ?, ?, ?, ?, ?, 1)`,
      ).run(display_name, locale, stringifyJsonColumn(section_tags), input.body, now);
    },
  };
}
