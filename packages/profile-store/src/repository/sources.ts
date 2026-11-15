import type {
  SourceId,
  SourceStatus,
  SourceStored,
  ListSourcesQuery,
  ListSourcesResponse,
} from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ProfileNotFoundError } from "../errors";
import { parseJsonColumn } from "../json";

interface SourceRow {
  id: string;
  idempotency_key: string | null;
  kind: string;
  original_name: string;
  mime_type: string;
  file_path: string | null;
  url: string | null;
  extracted_text: string;
  truncated: number;
  char_count: number;
  user_note: string;
  user_tags: string;
  status: string;
  metadata: string;
  created_at: string;
  last_ingested_at: string | null;
  last_error: string | null;
}

function rowToStored(row: SourceRow): SourceStored {
  return {
    id: row.id,
    ...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
    kind: row.kind as SourceStored["kind"],
    original_name: row.original_name,
    mime_type: row.mime_type as SourceStored["mime_type"],
    file_path: row.file_path,
    url: row.url,
    extracted_text: row.extracted_text,
    truncated: row.truncated === 1,
    char_count: row.char_count,
    user_note: row.user_note,
    user_tags: parseJsonColumn<string[]>(row.user_tags, []),
    status: row.status as SourceStatus,
    metadata: parseJsonColumn<Record<string, unknown>>(row.metadata, {}),
    created_at: row.created_at,
    last_ingested_at: row.last_ingested_at,
    last_error: row.last_error,
  };
}

export function createSourcesRepo(db: ProfileDb) {
  return {
    list(q: ListSourcesQuery): ListSourcesResponse {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (q.status) {
        conditions.push("status = ?");
        params.push(q.status);
      }
      if (q.tag) {
        conditions.push("user_tags LIKE ?");
        params.push(`%"${q.tag}"%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const countRow = db
        .prepare(`SELECT COUNT(*) as total FROM sources ${where}`)
        .get(...params) as { total: number };

      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const rows = db
        .prepare(`SELECT * FROM sources ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as SourceRow[];

      return {
        items: rows.map(rowToStored),
        total: countRow.total,
      };
    },

    get(id: SourceId): SourceStored {
      const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
      if (!row) {
        throw new ProfileNotFoundError(`source 不存在: ${id}`);
      }
      return rowToStored(row);
    },

    findByIdempotencyKey(key: string): SourceStored | undefined {
      const row = db
        .prepare("SELECT * FROM sources WHERE idempotency_key = ?")
        .get(key) as SourceRow | undefined;
      return row ? rowToStored(row) : undefined;
    },

    insert(s: SourceStored): void {
      db.prepare(
        `INSERT INTO sources
         (id, idempotency_key, kind, original_name, mime_type, file_path, url,
          extracted_text, truncated, char_count, user_note, user_tags,
          status, metadata, created_at, last_ingested_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.idempotency_key ?? null,
        s.kind,
        s.original_name,
        s.mime_type,
        s.file_path,
        s.url,
        s.extracted_text,
        s.truncated ? 1 : 0,
        s.char_count,
        s.user_note,
        JSON.stringify(s.user_tags),
        s.status,
        JSON.stringify(s.metadata),
        s.created_at,
        s.last_ingested_at,
        s.last_error,
      );
    },

    updateStatus(id: SourceId, status: SourceStatus, now: string): void {
      db.prepare(
        `UPDATE sources
         SET status = ?,
             last_ingested_at = CASE
               WHEN ? IN ('pending_review','completed') THEN ?
               ELSE last_ingested_at
             END,
             last_error = NULL
         WHERE id = ?`,
      ).run(status, status, now, id);
    },

    updateError(id: SourceId, error: string, _now: string): void {
      db.prepare(
        `UPDATE sources SET status = 'distill_failed', last_error = ? WHERE id = ?`,
      ).run(error, id);
    },

    countByStatus(): Partial<Record<SourceStatus, number>> {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS count FROM sources GROUP BY status")
        .all() as { status: SourceStatus; count: number }[];
      return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<
        Record<SourceStatus, number>
      >;
    },

    latestDistillAt(): string | null {
      const row = db
        .prepare("SELECT MAX(last_ingested_at) AS latest FROM sources")
        .get() as { latest: string | null };
      return row.latest;
    },

    /**
     * 改名（W-3 CRUD）：只改展示用的 `original_name`，不动内容与状态。
     * 空串不合法由路由层拦（此处不做业务校验，保持仓储「只做 SQL」的纪律）。
     */
    rename(id: SourceId, name: string): void {
      db.prepare("UPDATE sources SET original_name = ? WHERE id = ?").run(name, id);
    },

    updateNote(id: SourceId, note: string, tags: string[]): void {
      db.prepare("UPDATE sources SET user_note = ?, user_tags = ? WHERE id = ?").run(
        note,
        JSON.stringify(tags),
        id,
      );
    },

    delete(id: SourceId): void {
      db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    },

    deleteMany(ids: SourceId[]): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...ids);
    },
  };
}
