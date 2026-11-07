import type {
  JournalDateSummary,
  JournalDate,
  JournalEntryStored,
  AppendJournal,
  JournalRecordStored,
} from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ConstraintViolationError } from "../errors";
import { parseJsonColumn, stringifyJsonColumn } from "../json";

interface RecordRow {
  id: number;
  date: string;
  ordinal: number;
  recorded_at: string;
  provenance: string;
  tags: string;
  body: string;
}

function recordRowToStored(row: RecordRow): JournalRecordStored {
  return {
    id: row.id,
    date: row.date,
    ordinal: row.ordinal,
    recorded_at: row.recorded_at,
    provenance: row.provenance as JournalRecordStored["provenance"],
    tags: parseJsonColumn<string[]>(row.tags, []),
    body: row.body,
  };
}

export function createJournalRepo(db: ProfileDb) {
  return {
    listDates(): JournalDateSummary[] {
      const rows = db
        .prepare(
          `SELECT date, COUNT(*) as record_count, MAX(recorded_at) as updated_at
           FROM journal_records
           GROUP BY date
           ORDER BY date DESC`,
        )
        .all() as { date: string; record_count: number; updated_at: string }[];
      return rows.map((r) => ({
        date: r.date,
        record_count: r.record_count,
        updated_at: r.updated_at,
      }));
    },

    get(date: JournalDate): JournalEntryStored {
      const rows = db
        .prepare("SELECT * FROM journal_records WHERE date = ? ORDER BY ordinal")
        .all(date) as RecordRow[];
      return {
        date,
        records: rows.map(recordRowToStored),
      };
    },

    append(req: AppendJournal, now: string): JournalRecordStored {
      const insert = (): JournalRecordStored => {
        const maxRow = db
          .prepare("SELECT MAX(ordinal) as max_ord FROM journal_records WHERE date = ?")
          .get(req.date) as { max_ord: number | null };
        const nextOrd = (maxRow?.max_ord ?? 0) + 1;

        const result = db
          .prepare(
            `INSERT INTO journal_records (date, ordinal, recorded_at, provenance, tags, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(req.date, nextOrd, now, req.provenance, stringifyJsonColumn(req.tags), req.body);
        return {
          id: Number(result.lastInsertRowid),
          date: req.date,
          ordinal: nextOrd,
          recorded_at: now,
          provenance: req.provenance,
          tags: req.tags,
          body: req.body,
        };
      };

      try {
        return db.transaction(() => insert())();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint failed")) {
          return db.transaction(() => insert())();
        }
        throw new ConstraintViolationError(`journal append 失败: ${msg}`);
      }
    },
  };
}
