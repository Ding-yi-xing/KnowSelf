/**
 * 一次性脚本：把「身份口径」写进 identity 画像卡片。
 *
 * 为什么走画像卡片而不是旁路文件：画像的唯一真相源是卡片，
 * 旁挂一个 identity.md 迟早和画像互相矛盾（用户已指出这一点）。
 *
 * SQL 与 packages/profile-store 的 `cards.appendSection` 等价：
 * 确保卡片行存在 → 更新 updated_at → 按 (card_key,title) upsert section。
 *
 * 用法：node scripts/write-identity-card.mjs
 */
import Database from "better-sqlite3";

const IDENTITY_BODY = "泉州师范学院软件工程专业本科在读（2027 届应届生）。";
const now = new Date().toISOString();

const db = new Database("./data/profile.sqlite");
db.pragma("journal_mode = WAL");

const write = db.transaction(() => {
  db.prepare(
    "INSERT OR IGNORE INTO cards (key, title, summary, section_tags, updated_at, schema_version) VALUES (?, '', '', '[]', ?, 1)",
  ).run("identity", now);
  db.prepare("UPDATE cards SET updated_at = ? WHERE key = ?").run(now, "identity");

  const row = db.prepare("SELECT MAX(ord) AS max_ord FROM card_sections WHERE card_key = ?").get("identity");
  const nextOrd = (row?.max_ord ?? -1) + 1;

  db.prepare(
    `INSERT INTO card_sections (card_key, title, body, ord, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (card_key, title) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run("identity", "身份口径", IDENTITY_BODY, nextOrd, now);
});

write();
const saved = db.prepare("SELECT body FROM card_sections WHERE card_key = 'identity' AND title = '身份口径'").get();
db.close();

console.log("已写入 identity 卡片「身份口径」：", saved?.body ?? "(未找到)");
