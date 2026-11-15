#!/usr/bin/env node
/**
 * scripts/rebuild-persons.mjs — **显式重建** persons 派生库（P0 复盘产物）。
 *
 * ⚠ 这个脚本**不是「修密钥」工具**。它做的是：放弃现有 persons 库、用当前密钥
 *   新建一个空库，再从 `data/conversations.sqlite` 重放消息、跑一遍挖掘。
 *
 * ## 什么时候可以用
 *   ✅ persons 库与密钥确实不配对（打不开），且库里**只有派生数据**
 *      （人物/关系/事件/指标/图谱快照，全部可由消息重算）
 *   ❌ 库里有人工编辑（`manual_locked`、人工合并、备注等）→ **绝对不要跑**，
 *      请先找回原密钥。脚本无法自动判断哪些是人工数据，所以默认只 `--dry-run`。
 *
 * ## 为什么需要它
 * W-9/P0 复盘：曾有一份 persons 库，磁盘上两把钥匙都打不开；进程外 `Node`
 * 打不开、in-app（Electron ABI）能打开——**先别急着重建**，先在 in-app 里确认
 * 是不是环境假象（见 `docs/units/desktop/issues/ISS-009-persons-env-mismatch.md`）。
 *
 * ## 用法
 *   node scripts/rebuild-persons.mjs                # = --dry-run，只报现状
 *   node scripts/rebuild-persons.mjs --yes          # 真重建（会先备份 + 重命名旧库）
 *   node scripts/rebuild-persons.mjs --yes --force  # 检测不到进程列表时也继续（慎用）
 *
 * 重放/挖掘那段依赖工作区包（`@knowself/*` 的 dist 是无扩展名 ESM，纯 node 解析不了），
 * 所以**必须**通过 tsx 运行：
 *   npm run person:rebuild -- --dry-run
 *   npm run person:rebuild -- --yes
 *
 * ## 安全边界
 *   - 绝不删除旧库：只 `rename` 成 `persons.sqlite.pre-rebuild-<ts>` 并复制一份到备份目录；
 *   - 备份目录：`<home>/.dsh-lab/backup/persons-prebuild-<ts>/`
 *   - 先检查有没有 electron 进程占着库（Windows 下句柄占用会让 rename 直接失败，
 *     更糟的是「看起来成功了但读的是旧页缓存」——本次 P0 就是被这个绕进去的）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.KNOWSELF_ROOT_DIR ?? REPO_ROOT;
const DATA_DIR = join(ROOT, "data");
const PERSONS_DB = join(DATA_DIR, "persons.sqlite");
const CONVERSATIONS_DB = join(DATA_DIR, "conversations.sqlite");
const KEY_PATH =
  process.env.KNOWSELF_PERSONS_KEY_PATH ??
  join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "knowSelf", "keys", "persons.key");

const argv = process.argv.slice(2);
const DO_REBUILD = argv.includes("--yes");
const FORCE = argv.includes("--force");

/** 打印一行状态。 */
const log = (msg) => console.log(`[rebuild-persons] ${msg}`);

/** 文件 sha256（不存在返回 null）。 */
function sha256(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** 文件大小（不存在返回 null）。 */
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * 检测占着 persons 库的 electron 进程数。
 * @returns 进程数；无法检测时返回 `null`
 */
function countElectronProcesses() {
  const probe = spawnSync("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== "string") return null;
  return probe.stdout
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes("electron.exe")).length;
}

/** 当前状态快照（只读）。 */
function inspect() {
  const electron = countElectronProcesses();
  return {
    root: ROOT,
    personsDb: { path: PERSONS_DB, size: sizeOf(PERSONS_DB), sha256: sha256(PERSONS_DB) },
    conversationsDb: { path: CONVERSATIONS_DB, size: sizeOf(CONVERSATIONS_DB) },
    keyFile: { path: KEY_PATH, exists: existsSync(KEY_PATH), size: sizeOf(KEY_PATH) },
    electronProcesses: electron,
  };
}

const state = inspect();
log("现状：");
console.log(
  JSON.stringify(
    {
      ...state,
      // 密钥只看「在不在、多大」，绝不打印内容（NFR-10）
    },
    null,
    2,
  ),
);

if (!DO_REBUILD) {
  log("dry-run：未改动任何文件。要真重建请加 --yes（会先备份 + 重命名旧库）。");
  log("提示：重建前请先在 in-app 里确认库确实打不开，别把「进程外读不了但宿主能读」当成库坏了。");
  process.exit(0);
}

// ── 前置检查 ──────────────────────────────────────────────────────────────
if (!existsSync(PERSONS_DB)) {
  log("persons.sqlite 不存在：无需重建，直接启动应用即可按当前密钥新建。");
  process.exit(0);
}

if (state.electronProcesses === null) {
  if (!FORCE) {
    log("无法检测 electron 进程（tasklist 不可用）。若桌面正在运行，rename 会失败或读到旧页缓存。");
    log("确认已关闭桌面后加 --force 继续。");
    process.exit(2);
  }
  log("检测不到进程列表，已按 --force 继续（风险自负）。");
} else if (state.electronProcesses > 0) {
  log(`检测到 ${state.electronProcesses} 个 electron.exe 正在运行，拒绝重建。`);
  log("请先完全关闭桌面应用（含托盘），再重跑本命令。");
  log("原因：Windows 下句柄占用会让 rename 失败；更隐蔽的是「看似成功但读到旧页缓存」。");
  process.exit(3);
}

// ── 备份 + 重命名 ─────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const backupDir = join(homedir(), ".dsh-lab", "backup", `persons-prebuild-${ts}`);
mkdirSync(backupDir, { recursive: true });

for (const suffix of ["", "-wal", "-shm"]) {
  const from = `${PERSONS_DB}${suffix}`;
  if (!existsSync(from)) continue;
  copyFileSync(from, join(backupDir, `persons.sqlite${suffix}`));
  renameSync(from, `${from}.pre-rebuild-${ts}`);
}
log(`已备份到 ${backupDir}`);
log(`旧库已重命名为 *.pre-rebuild-${ts}（未删除）`);

// ── 重放 + 挖掘（需要 tsx：@knowself/* 的 dist 是无扩展名 ESM） ─────────────
let personStoreModule;
let miningModule;
let configModule;
try {
  [personStoreModule, miningModule, configModule] = await Promise.all([
    import("@knowself/person-store"),
    import("@knowself/mining"),
    import("@knowself/config"),
  ]);
} catch (err) {
  log("无法加载工作区包（多半是没用 tsx 跑，或 dist 尚未构建）：");
  log(String(err instanceof Error ? err.message : err).slice(0, 200));
  log("请用：npm run person:rebuild -- --yes");
  log("注意：此时旧库已被重命名，data/persons.sqlite 现在不存在；修好后重跑本命令即可（新库会按当前密钥创建）。");
  process.exit(4);
}

const paths = configModule.getDataPaths(ROOT);
const store = personStoreModule.createPersonStore({ dbPath: paths.personsDbPath });
const now = new Date().toISOString();

// 重放会话与消息（只读 conversations.sqlite）
let replayed = { conversations: 0, messages: 0 };
if (existsSync(CONVERSATIONS_DB)) {
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const src = new Database(CONVERSATIONS_DB, { readonly: true });
  const convs = src.prepare("SELECT id,title,created_at FROM conversations ORDER BY created_at").all();
  const msgs = src
    .prepare("SELECT id,conversation_id,role,content,created_at FROM messages ORDER BY created_at")
    .all();
  src.close();

  const textOf = (raw) => {
    if (typeof raw !== "string") return "";
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return raw;
      return parsed
        .map((b) => (b && b.kind === "text" && typeof b.text === "string" ? b.text : ""))
        .filter((t) => t !== "")
        .join("\n");
    } catch {
      return raw;
    }
  };

  for (const conv of convs) {
    const own = msgs.filter((m) => m.conversation_id === conv.id);
    store.conversations.upsertFromCommit(
      {
        conversation_id: conv.id,
        platform: "other",
        kind: "direct",
        title: conv.title,
        owner_person_id: "me",
        member_count: 2,
        first_msg_at: own[0]?.created_at ?? null,
        last_msg_at: own[own.length - 1]?.created_at ?? null,
        source_ref: "conversations.sqlite",
      },
      now,
    );
  }
  const inserted = store.messages.insertOrIgnore(
    msgs.map((m) => ({
      message_id: m.id,
      conversation_id: m.conversation_id,
      platform: "other",
      sender_id: m.role === "user" ? "me" : "assistant",
      sender_name: m.role === "user" ? "我" : "助手",
      role: m.role === "user" ? "me" : "other",
      ts_ms: Number.isFinite(Date.parse(m.created_at)) ? Date.parse(m.created_at) : Date.parse(now),
      msg_date: String(m.created_at).slice(0, 10),
      content: textOf(m.content),
      content_type: "text",
      reply_to: null,
      meta: JSON.stringify({ imported_from: "conversations.sqlite" }),
      batch_id: `rebuild-persons-${ts}`,
      ingested_at: now,
    })),
  );
  replayed = { conversations: convs.length, messages: inserted.inserted };
}

const mining = await miningModule.runMiningPipeline({ store, write: true });
const persons = store.listPersons();
const conversations = store.conversations.list();
store.close();

console.log(
  JSON.stringify(
    {
      replayed,
      persons: persons.length,
      conversations: conversations.length,
      mining: {
        snapshotId: mining.snapshotId,
        persons: mining.persons,
        scopes: mining.scopes,
        graphNodes: mining.graph?.nodes?.length ?? null,
        graphEdges: mining.graph?.edges?.length ?? null,
        warnings: mining.warnings,
      },
      backupDir,
    },
    null,
    2,
  ),
);
log("完成。若图谱仍为空，先看「有没有含他人参与的聊天数据」——本仓库当前只有你与助手的会话。");
