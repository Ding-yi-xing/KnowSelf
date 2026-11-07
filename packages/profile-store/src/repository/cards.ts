import type {
  CardSummary,
  CardWithSections,
  CardKey,
  CardInput,
  AppendCardSection,
  CardStored,
  CardSectionStored,
} from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ProfileNotFoundError } from "../errors";
import { parseJsonColumn, stringifyJsonColumn } from "../json";

function cardTags(raw: string): string[] {
  return parseJsonColumn<string[]>(raw, []);
}

interface CardRow {
  key: string;
  title: string;
  summary: string;
  section_tags: string;
  updated_at: string;
}

interface SectionRow {
  id: number;
  card_key: string;
  title: string;
  body: string;
  ord: number;
  updated_at: string;
}

function cardRowToStored(row: CardRow): CardStored {
  return {
    key: row.key,
    title: row.title,
    summary: row.summary,
    section_tags: cardTags(row.section_tags),
    updated_at: row.updated_at,
    schema_version: 1 as const,
  };
}

function sectionRowToStored(row: SectionRow): CardSectionStored {
  return {
    id: row.id,
    card_key: row.card_key,
    title: row.title,
    body: row.body,
    ord: row.ord,
    updated_at: row.updated_at,
  };
}

export function createCardsRepo(db: ProfileDb) {
  return {
    list(): CardSummary[] {
      const rows = db
        .prepare("SELECT key, title, summary, section_tags, updated_at FROM cards ORDER BY key")
        .all() as CardRow[];
      return rows.map((r) => ({
        key: r.key,
        title: r.title,
        summary: r.summary,
        section_tags: cardTags(r.section_tags),
        updated_at: r.updated_at,
      }));
    },

    get(key: CardKey): CardWithSections {
      const cardRow = db.prepare("SELECT * FROM cards WHERE key = ?").get(key) as
        | CardRow
        | undefined;
      if (!cardRow) {
        throw new ProfileNotFoundError(`card 不存在: ${key}`);
      }
      const sectionRows = db
        .prepare("SELECT * FROM card_sections WHERE card_key = ? ORDER BY ord")
        .all(key) as SectionRow[];
      return {
        card: cardRowToStored(cardRow),
        sections: sectionRows.map(sectionRowToStored),
      };
    },

    save(input: CardInput, now: string): void {
      db.transaction(() => {
        db.prepare("DELETE FROM card_sections WHERE card_key = ?").run(input.key);
        db.prepare(
          `INSERT OR REPLACE INTO cards
           (key, title, summary, section_tags, updated_at, schema_version)
           VALUES (?, ?, ?, ?, ?, 1)`,
        ).run(
          input.key,
          input.title,
          input.summary,
          stringifyJsonColumn(input.section_tags ?? []),
          now,
        );
        const insertSec = db.prepare(
          `INSERT INTO card_sections (card_key, title, body, ord, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (let i = 0; i < input.sections.length; i++) {
          const s = input.sections[i]!;
          insertSec.run(input.key, s.title, s.body, i, now);
        }
      })();
    },

    appendSection(req: AppendCardSection, now: string): void {
      db.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO cards (key, title, summary, section_tags, updated_at, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
        ).run(req.key, "", "", "[]", now);
        db.prepare("UPDATE cards SET updated_at = ? WHERE key = ?").run(now, req.key);

        const maxRow = db
          .prepare("SELECT MAX(ord) as max_ord FROM card_sections WHERE card_key = ?")
          .get(req.key) as { max_ord: number | null };
        const nextOrd = (maxRow?.max_ord ?? -1) + 1;

        db.prepare(
          `INSERT INTO card_sections (card_key, title, body, ord, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (card_key, title) DO UPDATE SET
             body = excluded.body,
             updated_at = excluded.updated_at`,
        ).run(req.key, req.section, req.body, nextOrd, now);
      })();
    },

    delete(key: CardKey): void {
      db.prepare("DELETE FROM cards WHERE key = ?").run(key);
    },
  };
}
