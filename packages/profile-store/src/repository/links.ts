import type {
  SourceId,
  ProfileSourceRefKind,
  ProfileSourceLink,
  ProfileLinkedSourcesResponse,
} from "@knowself/contracts";
import type { ProfileDb } from "../db";
import { ConstraintViolationError } from "../errors";

interface LinkRow {
  profile_kind: string;
  profile_id: string;
  source_id: string;
  proposal_id: string | null;
  created_at: string;
}

function linkRowToStored(row: LinkRow): ProfileSourceLink {
  return {
    profile_kind: row.profile_kind as ProfileSourceRefKind,
    profile_id: row.profile_id,
    source_id: row.source_id,
    proposal_id: row.proposal_id,
    created_at: row.created_at,
  };
}

export function createLinksRepo(db: ProfileDb) {
  return {
    insert(link: ProfileSourceLink): void {
      try {
        db.prepare(
          `INSERT INTO profile_sources
           (profile_kind, profile_id, source_id, proposal_id, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (profile_kind, profile_id, source_id) DO UPDATE SET
             proposal_id = COALESCE(profile_sources.proposal_id, excluded.proposal_id)`,
        ).run(
          link.profile_kind,
          link.profile_id,
          link.source_id,
          link.proposal_id ?? null,
          link.created_at,
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code?.startsWith("SQLITE_CONSTRAINT")) {
          throw new ConstraintViolationError(
            `profile source link insert failed: ${e.message ?? "constraint violation"}`,
          );
        }
        throw err;
      }
    },

    listForProfile(kind: ProfileSourceRefKind, id: string): ProfileLinkedSourcesResponse {
      const linkRows = db
        .prepare(
          `SELECT * FROM profile_sources
           WHERE profile_kind = ? AND profile_id = ?`,
        )
        .all(kind, id) as LinkRow[];
      const links = linkRows.map(linkRowToStored);

      const sourceIds = [...new Set(links.map((l) => l.source_id))];
      const sources: ProfileLinkedSourcesResponse["sources"] = [];
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => "?").join(",");
        const sourceRows = db
          .prepare(`SELECT * FROM sources WHERE id IN (${placeholders})`)
          .all(...sourceIds) as {
          id: string;
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
        }[];
        for (const s of sourceRows) {
          sources.push({
            id: s.id,
            kind: s.kind as "file" | "url" | "paste",
            original_name: s.original_name,
            mime_type: s.mime_type as ProfileLinkedSourcesResponse["sources"][number]["mime_type"],
            file_path: s.file_path,
            url: s.url,
            extracted_text: s.extracted_text,
            truncated: s.truncated === 1,
            char_count: s.char_count,
            user_note: s.user_note,
            user_tags: [],
            status: s.status as ProfileLinkedSourcesResponse["sources"][number]["status"],
            metadata: {},
            created_at: s.created_at,
            last_ingested_at: s.last_ingested_at,
            last_error: s.last_error,
          });
        }
      }

      return { links, sources };
    },

    listForSource(sourceId: SourceId): ProfileSourceLink[] {
      const rows = db
        .prepare("SELECT * FROM profile_sources WHERE source_id = ?")
        .all(sourceId) as LinkRow[];
      return rows.map(linkRowToStored);
    },
  };
}
