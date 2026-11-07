import { mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import Database from "better-sqlite3";
import AdmZip from "adm-zip";
import type { ImportMode, ImportResponse } from "@knowself/contracts";
import type { ProfileDb } from "./db";

const IMPORT_TABLES = [
  "core_profile",
  "cards",
  "card_sections",
  "journal_records",
  "sources",
] as const;

export async function importProfile(
  db: ProfileDb,
  zipPath: string,
  mode: ImportMode,
): Promise<ImportResponse> {
  const workDir = join(
    tmpdir(),
    `knowself-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(workDir, { recursive: true });

  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(workDir, true);

    const dbZipPath = join(workDir, "profile.sqlite");
    if (!existsSync(dbZipPath)) {
      throw new Error("导入文件缺少 profile.sqlite");
    }

    const verDb = new Database(dbZipPath, { readonly: true });
    let importVersion: string | undefined;
    try {
      const row = verDb
        .prepare("SELECT value FROM profile_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      importVersion = row?.value;
    } finally {
      verDb.close();
    }

    if (importVersion !== "1") {
      throw new Error(`导入文件 schema_version 不兼容（期待 1，实际 ${importVersion ?? "无"}`);
    }

    if (mode === "dry-run") {
      const localCounts: Record<string, number> = {};
      const remoteCounts: Record<string, number> = {};

      const readDb = new Database(dbZipPath, { readonly: true });
      try {
        for (const t of IMPORT_TABLES) {
          localCounts[t] = (
            db.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get() as { cnt: number }
          ).cnt;
          remoteCounts[t] = (
            readDb.prepare(`SELECT COUNT(*) as cnt FROM ${t}`).get() as { cnt: number }
          ).cnt;
        }
      } finally {
        readDb.close();
      }

      return {
        mode: "dry-run",
        imported: { tables: remoteCounts, sources: remoteCounts.sources ?? 0 },
        conflicts: [],
      };
    }

    if (mode === "replace") {
      const dbPath = (db.raw as unknown as { name: string }).name;
      const backupPath = dbPath + ".bak";

      if (existsSync(backupPath)) {
        await rm(backupPath, { force: true });
      }

      db.raw.close();
      renameSync(dbPath, backupPath);
      renameSync(dbZipPath, dbPath);

      return {
        mode: "replace",
        imported: {
          tables: { core_profile: 1, cards: 0, card_sections: 0, journal_records: 0, sources: 0 },
          sources: 0,
        },
        conflicts: [],
      };
    }

    const readDb = new Database(dbZipPath, { readonly: true });
    const conflicts: ImportResponse["conflicts"] = [];
    let cardCount = 0;
    let sectionCount = 0;
    let journalCount = 0;
    let sourceCount = 0;

    try {
      const remoteCards = readDb
        .prepare("SELECT key, title, summary, section_tags, updated_at FROM cards ORDER BY key")
        .all() as {
        key: string;
        title: string;
        summary: string;
        section_tags: string;
        updated_at: string;
      }[];
      const remoteSections = readDb
        .prepare(
          "SELECT card_key, title, body, ord, updated_at FROM card_sections ORDER BY card_key, ord",
        )
        .all() as {
        card_key: string;
        title: string;
        body: string;
        ord: number;
        updated_at: string;
      }[];
      const remoteJournal = readDb
        .prepare(
          "SELECT id, date, ordinal, recorded_at, provenance, tags, body FROM journal_records ORDER BY id",
        )
        .all() as {
        id: number;
        date: string;
        ordinal: number;
        recorded_at: string;
        provenance: string;
        tags: string;
        body: string;
      }[];
      const remoteSources = readDb
        .prepare("SELECT id, kind, original_name, status, created_at FROM sources ORDER BY id")
        .all() as {
        id: string;
        kind: string;
        original_name: string;
        status: string;
        created_at: string;
      }[];

      cardCount = remoteCards.length;
      sectionCount = remoteSections.length;
      journalCount = remoteJournal.length;
      sourceCount = remoteSources.length;

      const txn = db.transaction(() => {
        for (const rc of remoteCards) {
          const local = db
            .prepare("SELECT key, updated_at FROM cards WHERE key = ?")
            .get(rc.key) as { key: string; updated_at: string } | undefined;
          if (!local) {
            db.prepare(
              "INSERT INTO cards (key, title, summary, section_tags, updated_at, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
            ).run(rc.key, rc.title, rc.summary, rc.section_tags, rc.updated_at);
          } else if (rc.updated_at > local.updated_at) {
            db.prepare(
              "UPDATE cards SET title = ?, summary = ?, section_tags = ?, updated_at = ? WHERE key = ?",
            ).run(rc.title, rc.summary, rc.section_tags, rc.updated_at, rc.key);
          } else if (rc.updated_at < local.updated_at) {
            conflicts.push({
              table: "cards",
              key: rc.key,
              local: local.updated_at,
              remote: rc.updated_at,
              resolution: "local_wins",
            });
          }
        }

        for (const rs of remoteSections) {
          const local = db
            .prepare(
              "SELECT id, updated_at FROM card_sections WHERE card_key = ? AND title = ? AND ord = ?",
            )
            .get(rs.card_key, rs.title, rs.ord) as { id: number; updated_at: string } | undefined;
          if (!local) {
            db.prepare(
              "INSERT INTO card_sections (card_key, title, body, ord, updated_at) VALUES (?, ?, ?, ?, ?)",
            ).run(rs.card_key, rs.title, rs.body, rs.ord, rs.updated_at);
          } else if (rs.updated_at > local.updated_at) {
            db.prepare("UPDATE card_sections SET body = ?, updated_at = ? WHERE id = ?").run(
              rs.body,
              rs.updated_at,
              local.id,
            );
          }
        }

        for (const rj of remoteJournal) {
          const local = db.prepare("SELECT id FROM journal_records WHERE id = ?").get(rj.id) as
            | { id: number }
            | undefined;
          if (!local) {
            db.prepare(
              "INSERT INTO journal_records (id, date, ordinal, recorded_at, provenance, tags, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run(rj.id, rj.date, rj.ordinal, rj.recorded_at, rj.provenance, rj.tags, rj.body);
          }
        }

        for (const rs of remoteSources) {
          const local = db.prepare("SELECT id FROM sources WHERE id = ?").get(rs.id) as
            | { id: string }
            | undefined;
          if (!local) {
            db.prepare(
              "INSERT INTO sources (id, kind, original_name, status, created_at) VALUES (?, ?, ?, ?, ?)",
            ).run(rs.id, rs.kind, rs.original_name, rs.status, rs.created_at);
          }
        }
      });
      txn();
    } finally {
      readDb.close();
    }

    return {
      mode: "merge",
      imported: {
        tables: {
          cards: cardCount,
          card_sections: sectionCount,
          journal_records: journalCount,
          sources: sourceCount,
        },
        sources: sourceCount,
      },
      conflicts,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
