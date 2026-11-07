import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPersonDb, type PersonDb, type PersonDbOptions } from "../src/db";

/** 合成密钥（测试专用，非真实密钥）：32 字节 0x6b / 0x7f。 */
export const KEY = Buffer.alloc(32, 0x6b).toString("base64");
export const WRONG_KEY = Buffer.alloc(32, 0x7f).toString("base64");
export const MARKER = "PLAINTEXT_LEAKED_MARKER";
/** 明文 SQLite 文件头 `SQLite format 3\0` 的 hex（避免源码出现 NUL 字节）。 */
export const SQLITE_HEADER_HEX = "53514c69746520666f726d6174203300";

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "knowself-person-store-"));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function closeAll(opened: PersonDb[]): void {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

export function openIn(
  dir: string,
  opened: PersonDb[],
  name: string,
  options: Partial<PersonDbOptions> = {},
): PersonDb {
  const db = openPersonDb({ dbPath: join(dir, name), encryption: { mode: "none" }, ...options });
  opened.push(db);
  return db;
}

export function meta(db: PersonDb, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM persons_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** 主库 + `-wal` 的字节拼接（关闭后 WAL 可能未 checkpoint 进主库）。 */
export function rawBytes(dbPath: string): Buffer {
  const parts = [readFileSync(dbPath)];
  if (existsSync(`${dbPath}-wal`)) {
    parts.push(readFileSync(`${dbPath}-wal`));
  }
  return Buffer.concat(parts);
}

export function columns(db: PersonDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}
