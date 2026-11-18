/**
 * 一次性清理：删除 identity 卡片里重复的「身份锚」section。
 *
 * 背景：13:45 曾写入一条「身份锚」，13:57 又写入「身份口径」，两者内容重复。
 * 身份口径只保留一条，避免画像里出现两个相似说法。
 */
import Database from "better-sqlite3";

const db = new Database("./data/profile.sqlite");
db.pragma("journal_mode = WAL");

const before = db
  .prepare("SELECT id, title, body FROM card_sections WHERE card_key = 'identity' AND title LIKE '身份%'")
  .all();
console.log("before:", before.map((row) => `${row.id}:${row.title}`).join(", "));

db.prepare("DELETE FROM card_sections WHERE card_key = 'identity' AND title = '身份锚'").run();

const after = db
  .prepare("SELECT id, title, body FROM card_sections WHERE card_key = 'identity' AND title LIKE '身份%'")
  .all();
db.close();

console.log("after:", after.map((row) => `${row.id}:${row.title} => ${row.body}`).join(" | "));
