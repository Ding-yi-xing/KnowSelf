import { mkdirSync, createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import archiver from "archiver";
import type { ExportRequest, ExportResponse } from "@knowself/contracts";
import type { ProfileDb } from "./db";
import { parseJsonColumn } from "./json";

/** 流式生成 zip buffer（不落盘），供 server 直接 HTTP response。 */
export async function exportProfileBuffer(deps: {
  db: ProfileDb;
  sourcesDir: string;
}): Promise<Buffer> {
  const tmpDir = join(tmpdir(), `knowself-export-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tmpDbPath = join(tmpDir, "profile.sqlite");

  await deps.db.raw.backup(tmpDbPath);

  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = createWriteStream(tmpDir + "/_out.zip");

  archive.pipe(output);
  archive.file(tmpDbPath, { name: "profile.sqlite" });
  archive.directory(deps.sourcesDir, "sources");
  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });

  const { readFileSync, unlinkSync } = await import("node:fs");
  const buf = readFileSync(tmpDir + "/_out.zip");
  unlinkSync(tmpDbPath);
  unlinkSync(tmpDir + "/_out.zip");

  return buf;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function exportSqlite(
  db: ProfileDb,
  sourcesDir: string,
  exportsDir: string,
): Promise<string> {
  const ts = timestamp();
  const zipName = `profile-export-${ts}.zip`;
  const zipPath = join(exportsDir, zipName);
  const tmpDbPath = join(exportsDir, `_profile-${ts}.sqlite`);

  mkdirSync(exportsDir, { recursive: true });

  await db.raw.backup(tmpDbPath);

  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);

  archive.file(tmpDbPath, { name: "profile.sqlite" });
  archive.directory(sourcesDir, "sources");
  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });

  return zipPath;
}

function dumpMarkdown(db: ProfileDb): string {
  const lines: string[] = [];

  const core = db.prepare("SELECT * FROM core_profile WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (core) {
    lines.push("# L1: 核心档案");
    lines.push("");
    lines.push(`**display_name**: ${core.display_name || ""}`);
    lines.push(`**locale**: ${core.locale}`);
    lines.push(
      `**section_tags**: ${JSON.stringify(parseJsonColumn<string[]>((core.section_tags as string) ?? "[]", []))}`,
    );
    lines.push(`**updated_at**: ${core.updated_at}`);
    lines.push("");
    lines.push((core.body as string) || "");
    lines.push("");
  }

  const cardRows = db.prepare("SELECT * FROM cards ORDER BY key").all() as {
    key: string;
    title: string;
    summary: string;
    section_tags: string;
  }[];
  if (cardRows.length > 0) {
    lines.push("# L2: 卡片");
    lines.push("");
    for (const card of cardRows) {
      lines.push(`## ${card.title}`);
      lines.push("");
      lines.push(`**key**: ${card.key}`);
      lines.push(`**summary**: ${card.summary}`);
      lines.push(`**tags**: ${JSON.stringify(parseJsonColumn<string[]>(card.section_tags, []))}`);
      lines.push("");

      const sections = db
        .prepare("SELECT * FROM card_sections WHERE card_key = ? ORDER BY ord")
        .all(card.key) as { title: string; body: string }[];
      for (const sec of sections) {
        lines.push(`### ${sec.title}`);
        lines.push("");
        lines.push(sec.body);
        lines.push("");
      }
    }
  }

  const journalRows = db
    .prepare("SELECT * FROM journal_records ORDER BY date DESC, ordinal")
    .all() as {
    date: string;
    ordinal: number;
    body: string;
    provenance: string;
    tags: string;
    recorded_at: string;
  }[];
  if (journalRows.length > 0) {
    lines.push("# L3: 日记");
    lines.push("");
    let currentDate = "";
    for (const r of journalRows) {
      if (r.date !== currentDate) {
        currentDate = r.date;
        lines.push(`## ${currentDate}`);
        lines.push("");
      }
      lines.push(`### entry ${r.ordinal} (${r.provenance})`);
      lines.push("");
      lines.push(`_tags_: ${JSON.stringify(parseJsonColumn<string[]>(r.tags, []))}`);
      lines.push("");
      lines.push(r.body);
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function exportMarkdown(db: ProfileDb, exportsDir: string): Promise<string> {
  const ts = timestamp();
  const zipName = `profile-export-md-${ts}.zip`;
  const zipPath = join(exportsDir, zipName);

  mkdirSync(exportsDir, { recursive: true });

  const md = dumpMarkdown(db);
  const tmpMdPath = join(exportsDir, `_profile-${ts}.md`);
  await writeFile(tmpMdPath, md, "utf-8");

  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  archive.file(tmpMdPath, { name: "profile.md" });
  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });

  return zipPath;
}

async function exportJson(db: ProfileDb, exportsDir: string): Promise<string> {
  const ts = timestamp();
  const jsonName = `profile-export-${ts}.json`;
  const jsonPath = join(exportsDir, jsonName);

  mkdirSync(exportsDir, { recursive: true });

  const core = db.prepare("SELECT * FROM core_profile WHERE id = 1").get();
  const cards = db.prepare("SELECT * FROM cards ORDER BY key").all();
  const cardSections = db.prepare("SELECT * FROM card_sections ORDER BY card_key, ord").all();
  const journal = db.prepare("SELECT * FROM journal_records ORDER BY date DESC, ordinal").all();
  const sources = db.prepare("SELECT * FROM sources ORDER BY created_at DESC").all();

  const data = {
    exported_at: new Date().toISOString(),
    core_profile: core,
    cards,
    card_sections: cardSections,
    journal_records: journal,
    sources,
  };

  await writeFile(jsonPath, JSON.stringify(data, null, 2), "utf-8");

  return jsonPath;
}

export async function exportProfile(
  deps: { db: ProfileDb; sourcesDir: string; exportsDir: string },
  req: ExportRequest,
): Promise<ExportResponse> {
  mkdirSync(deps.exportsDir, { recursive: true });

  let downloadPath: string;

  if (req.format === "sqlite") {
    downloadPath = await exportSqlite(deps.db, deps.sourcesDir, deps.exportsDir);
  } else if (req.format === "markdown") {
    downloadPath = await exportMarkdown(deps.db, deps.exportsDir);
  } else {
    downloadPath = await exportJson(deps.db, deps.exportsDir);
  }

  const { statSync } = await import("node:fs");
  const sizeBytes = statSync(downloadPath).size;

  return {
    download_path: basename(downloadPath),
    format: req.format,
    size_bytes: sizeBytes,
    generated_at: new Date().toISOString(),
  };
}
