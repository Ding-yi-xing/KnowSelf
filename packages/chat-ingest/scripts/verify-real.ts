/**
 * 真实数据验证脚本（工单 6 验收）：对真实导出目录跑一次摄入并打印统计。
 *
 * 用法（在仓库根目录）：
 *   npx tsx packages/chat-ingest/scripts/verify-real.ts [导出目录] [--only 关键字] [--db 路径]
 *
 * 约束：导出目录**只读**；打印内容一律截断到 40 字符以内（隐私）。
 * 缺省库路径 = `<仓库根>/data/persons.sqlite`（DESIGN-10 §8.1）。
 */
import { resolvePersonsKey, getDataPaths } from "@knowself/config";
import { createPersonStore, type EncryptionMode } from "@knowself/person-store";
import { fileURLToPath } from "node:url";
import { ingestExport } from "../src/index";
import { describeError } from "../src/errors";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** 实测产物目录（工单给定；只读）。 */
const DEFAULT_EXPORT_DIR =
  "C:\\Users\\40179\\Documents\\AllProjecks\\wechat-extract-spike\\wechat-chat-export-decrypt\\export";
const EXCERPT = 40;

interface Args {
  dir: string;
  dbPath: string;
  only: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const only: string[] = [];
  let dbPath = getDataPaths(ROOT).personsDbPath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--only") {
      only.push(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--db") {
      dbPath = argv[i + 1] ?? dbPath;
      i += 1;
      continue;
    }
    if (arg !== "") positional.push(arg);
  }
  return { dir: positional[0] ?? DEFAULT_EXPORT_DIR, dbPath, only };
}

/** 有密钥就用 sqlcipher，否则明文并显式告警（本工单不引入密钥管理）。 */
function resolveMode(): EncryptionMode {
  try {
    resolvePersonsKey();
    return "sqlcipher";
  } catch {
    return "none";
  }
}

function cut(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= EXCERPT ? flat : `${flat.slice(0, EXCERPT)}…`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = resolveMode();
  if (mode === "none") {
    console.warn("[WARN] 未找到 persons 密钥（KNOWSELF_PERSONS_KEY / %APPDATA%\\knowSelf\\keys），以明文建库");
  }
  console.log(`[i] 导出目录 : ${args.dir}`);
  console.log(`[i] 数据库   : ${args.dbPath}（encryption=${mode}）`);
  console.log(`[i] 过滤关键字: ${args.only.length === 0 ? "(全量)" : args.only.join(", ")}`);

  const store = createPersonStore({ dbPath: args.dbPath, encryption: { mode } });
  try {
    const result = await ingestExport({ store, dir: args.dir, ...(args.only.length > 0 ? { only: args.only } : {}) });
    console.log("\n=== 摄入结果 ===");
    console.log(`批次        : ${result.batch_id}`);
    console.log(`reader      : ${result.reader_id}`);
    console.log(`会话数      : ${result.conversation_count}`);
    console.log(`消息数      : ${result.message_count}`);
    console.log(`落档 committed / skipped : ${result.committed} / ${result.skipped}`);
    console.log(`保真度 issue: ${result.issues.length}`);
    for (const issue of result.issues.slice(0, 5)) {
      console.log(`  - [${issue.code}] line ${issue.line_no}: ${cut(issue.excerpt)}`);
    }

    console.log("\n=== 抽样（每条截断 40 字符） ===");
    const conversations = store.conversations.list({ limit: 3 });
    for (const conversation of conversations) {
      const [message] = store.messages.list({ conversation_id: conversation.conversation_id, limit: 1 });
      const who = message?.sender_name ?? "?";
      console.log(
        `  ${cut(conversation.title)}（${conversation.kind}/${conversation.msg_count} 条）` +
          ` ${message?.msg_date ?? "-"} ${cut(who)}: ${cut(message?.content ?? "")}`,
      );
    }
    console.log(`\n[i] 库内总计：chat_messages=${store.messages.count()}，会话=${store.conversations.list().length}`);
  } finally {
    store.close();
  }
}

main().catch((cause: unknown) => {
  console.error(`[ERR] ${describeError(cause)}`);
  process.exitCode = 1;
});
