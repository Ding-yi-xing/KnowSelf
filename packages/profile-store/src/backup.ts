import { mkdirSync, readdirSync, unlinkSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import archiver from "archiver";
import type { BackupSchedule } from "@knowself/contracts";
import type { ProfileDb } from "./db";

export function scheduleBackup(
  db: ProfileDb,
  schedule: BackupSchedule,
  exportsDir: string,
): { stop: () => void } {
  if (!schedule.enabled) {
    return { stop: () => {} };
  }

  const intervalMs = schedule.interval === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void runBackup(db, exportsDir, schedule.keep);
  }, intervalMs);

  process.on("beforeExit", () => {
    void runBackup(db, exportsDir, schedule.keep);
  });

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

async function runBackup(db: ProfileDb, exportsDir: string, keep: number): Promise<void> {
  mkdirSync(exportsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const zipName = `backup-${ts}.zip`;
  const zipPath = join(exportsDir, zipName);

  const tmpDbPath = join(exportsDir, `_backup-${ts}.sqlite`);
  await db.raw.backup(tmpDbPath);

  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  archive.file(tmpDbPath, { name: "profile.sqlite" });
  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });

  cleanupOldBackups(exportsDir, keep);
}

function cleanupOldBackups(exportsDir: string, keep: number): void {
  const files = readdirSync(exportsDir, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.startsWith("backup-") && f.name.endsWith(".zip"))
    .map((f) => f.name)
    .sort()
    .reverse();

  for (let i = keep; i < files.length; i++) {
    const name = files[i];
    if (!name) continue;
    try {
      unlinkSync(join(exportsDir, name));
    } catch {
      // silent
    }
  }
}
