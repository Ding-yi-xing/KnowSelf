#!/usr/bin/env node
/**
 * 记录一条「口吻纠正」。
 *
 * 背景（抄自 ex-skill 的 correction 回流）：用户说「不像我 / 太正式了 / 我从不用啊」之后，
 * 这句话必须比模型自己总结的风格优先级更高，下一次生成就该体现，而不是每次重启又忘掉。
 *
 * 用法：
 *   node scripts/add-reply-correction.mjs --contact wxid_xxx --wrong "太正式" --right "我一般说「行吧」"
 *   node scripts/add-reply-correction.mjs --contact wxid_xxx --wrong "爱用「啊」结尾" --right "我从不用啊"
 *   node scripts/add-reply-correction.mjs --contact wxid_xxx --wrong "每条都两三句" --right "我一次只发一句" --layer "Layer 2"
 *
 * 写入 `data/profile.sqlite` 的 `profile_meta`（key = reply_corrections:<contact_id>），
 * 按联系人存、最多保留 20 条；不需要重启 App，**重新启动该联系人的回复任务**就会带上。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const contact = flag("contact");
const wrong = flag("wrong");
const right = flag("right");
const layer = flag("layer") ?? "Layer 2";

if (contact === undefined || wrong === undefined || right === undefined) {
  console.error(
    "用法: node scripts/add-reply-correction.mjs --contact <wxid> --wrong <旧说法/旧风格> --right <正确说法> [--layer \"Layer 2\"]",
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new Database(path.join(root, "data", "profile.sqlite"));
const key = `reply_corrections:${contact}`;

const row = db.prepare("SELECT value FROM profile_meta WHERE key = ?").get(key);
let list = [];
try {
  const parsed = JSON.parse(row?.value ?? "[]");
  if (Array.isArray(parsed)) list = parsed;
} catch {
  list = [];
}

list.push({ layer, wrong, right, at: new Date().toISOString() });
const trimmed = list.slice(-20);

db.prepare(
  `INSERT INTO profile_meta (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(key, JSON.stringify(trimmed));
db.close();

console.log(`已记录：${contact}｜「${wrong}」→「${right}」（${layer}），当前共 ${trimmed.length} 条。`);
console.log("重新启动这个联系人的回复任务后生效。");
