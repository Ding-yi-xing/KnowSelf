/**
 * ingest-chat.ts — 聊天记录导入 CLI（chat-ingest 的生产入口，P0-6 尾项）
 *
 * 为什么是 CLI 而不是 HTTP 路由：补入口需要新增 path，而 `DESIGN-19 §3-Q1` 明确
 * 「P1~P4 路由 path 未定稿，实施时不得自造 path」。聊天导入本身是低频运维动作，
 * CLI 是当前约束下最小且正确的入口形态；path 定稿后可平移为路由，核心逻辑不变。
 *
 * 用法：
 *   npx tsx apps/server/src/cli/ingest-chat.ts --dir "<导出目录>" [--source-id <id>] [--only 张三] [--no-index]
 *   npm run ingest:chat -- --dir "<导出目录>"
 *
 * 行为：
 *   1. 复用 `bootRuntime`（与 server 完全一致的装配：profileStore / personStore / ingestion / contextRouter）
 *   2. 未给 `--source-id` 时创建一条 `paste` 型 Source 作为本次导入的载体
 *   3. Tier 名单从 `data/chat-ingest/{auto_ok,review}.txt` 读取（每行一个 id，# 开头为注释）
 *   4. `ingestExport` → Tier A 自动 accept → 经 chatCommitter 落 persons.sqlite
 *   5. 默认导入后重建聊天索引（`--no-index` 跳过），保证导入完即可被检索
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ingestExport, type IngestTierConfig } from "@knowself/chat-ingest";
import { bootRuntime } from "../orchestrator/init";
import { createProfileProposalSink } from "../orchestrator/chat-proposal-sink";
import { createChatMessageCommitter } from "@knowself/chat-ingest";
import type { CreateSourceRequest } from "@knowself/contracts";

interface CliOptions {
  dir: string;
  sourceId?: string;
  only: string[];
  rebuildIndex: boolean;
  rootDir: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    dir: "",
    only: [],
    rebuildIndex: true,
    rootDir: process.cwd(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dir":
        opts.dir = argv[++i] ?? "";
        break;
      case "--source-id":
        opts.sourceId = argv[++i] ?? "";
        break;
      case "--only":
        opts.only.push(argv[++i] ?? "");
        break;
      case "--no-index":
        opts.rebuildIndex = false;
        break;
      case "--root":
        opts.rootDir = argv[++i] ?? process.cwd();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--dir=")) opts.dir = arg.slice(6);
        else if (arg.startsWith("--source-id=")) opts.sourceId = arg.slice(12);
        else if (arg.startsWith("--only=")) opts.only.push(arg.slice(7));
        else {
          console.error(`未知参数：${arg}`);
          printUsage();
          process.exit(2);
        }
    }
  }

  opts.only = opts.only.map((s) => s.trim()).filter((s) => s.length > 0);
  return opts;
}

function printUsage(): void {
  console.log(
    [
      "用法：npx tsx apps/server/src/cli/ingest-chat.ts --dir <导出目录> [选项]",
      "",
      "选项：",
      "  --dir <path>        必填。微信导出产物目录（只读，不会修改源文件）",
      "  --source-id <id>    复用既有 Source；缺省自动创建一条 paste 型 Source",
      "  --only <keyword>    只导入 conversation_key / title 命中关键字的会话，可重复",
      "  --no-index          导入后不重建聊天索引（默认会重建）",
      "  --root <path>       项目根目录（默认当前工作目录，需含 settings.json）",
      "  -h, --help          显示本帮助",
      "",
      "Tier 名单：data/chat-ingest/auto_ok.txt、data/chat-ingest/review.txt（每行一个 id，# 为注释）",
    ].join("\n"),
  );
}

/** 读取名单文件；文件不存在返回空数组（不报错）。 */
function readList(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function loadTierConfig(rootDir: string): IngestTierConfig {
  const dir = join(rootDir, "data", "chat-ingest");
  return {
    auto_ok: readList(join(dir, "auto_ok.txt")),
    review: readList(join(dir, "review.txt")),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    console.error("缺少必填参数 --dir");
    printUsage();
    process.exit(2);
  }

  const dir = resolve(opts.dir);
  if (!existsSync(dir)) {
    console.error(`导出目录不存在：${dir}`);
    process.exit(2);
  }

  console.log(`[chat-ingest] 导出目录：${dir}`);
  const { runtime } = await bootRuntime(opts.rootDir);

  try {
    // 1. Source 载体（未显式指定则建一条 paste 型，便于在 UI 里追溯本次导入）
    let sourceId = opts.sourceId;
    if (!sourceId) {
      const req: CreateSourceRequest = {
        kind: "paste",
        text: `聊天记录导入：${dir}`,
        original_name: `chat-import-${basename(dir)}`,
        user_note: "",
        user_tags: [],
      };
      const source = await runtime.ingestion.createSource(req);
      sourceId = source.id;
      console.log(`[chat-ingest] 已创建 Source：${sourceId}`);
    }

    // 2. 注入 sink + committer（Tier A 自动 accept 走 ingestion → committer）
    const proposalSink = createProfileProposalSink({
      profileStore: runtime.profileStore,
      acceptProposal: (id) => runtime.ingestion.acceptProposal(id),
    });
    const chatCommitter = createChatMessageCommitter(runtime.personStore);
    const tierConfig = loadTierConfig(opts.rootDir);

    console.log(
      `[chat-ingest] Tier 名单：auto_ok=${tierConfig.auto_ok?.length ?? 0} 条，review=${tierConfig.review?.length ?? 0} 条`,
    );

    // 3. 执行导入
    const result = await ingestExport({
      store: runtime.personStore,
      dir,
      source_id: sourceId,
      proposalSink,
      chatCommitter,
      tierConfig,
      ...(opts.only.length > 0 ? { only: opts.only } : {}),
    });

    console.log("\n=== 导入结果 ===");
    console.log(`模式          ：${result.mode}`);
    console.log(`批 次         ：${result.batch_id}`);
    console.log(`reader        ：${result.reader_id}`);
    console.log(`会话 / 消息   ：${result.conversation_count} / ${result.message_count}`);
    console.log(`落档 / 跳过   ：${result.committed} / ${result.skipped}`);
    console.log(`层级（auto/review）：${result.tier.auto} / ${result.tier.review}`);
    console.log(
      `proposal      ：新建 ${result.proposals.created} / 自动接受 ${result.proposals.accepted} / 入队 ${result.proposals.queued} / 复用 ${result.proposals.reused}`,
    );
    console.log(`游标过滤      ：${result.cursor_filtered}`);
    // 适配器告警（正确性降级通知）：与下面的 `解析问题` 分开——后者是数据缺陷，这里是"本次结论不完整"。
    if (result.warnings.length > 0) {
      console.log(`告警          ：${result.warnings.length} 条（本次结论可能不完整）`);
      for (const warning of result.warnings) console.log(`  - ${warning}`);
    }
    if (result.issues.length > 0) {
      console.log(`解析问题      ：${result.issues.length} 条`);
      const byCode = new Map<string, number>();
      for (const issue of result.issues) byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
      for (const [code, n] of [...byCode.entries()].slice(0, 10)) {
        console.log(`  - ${code} × ${n}`);
      }
    }

    // 4. 重建聊天索引（CLI 进程退出后订阅已不存在，需显式重建一次）
    if (opts.rebuildIndex) {
      const started = Date.now();
      const idx = await runtime.contextRouter.buildChatIndex();
      console.log(
        `\n[index] 聊天索引：${idx.conversationCount} 会话 / ${idx.windowCount} 窗口 / ${idx.chunkCount} 行 / ${idx.embeddedCount} 向量（${Date.now() - started}ms）`,
      );
    }

    if (result.tier.review > 0) {
      console.log(
        `\n提示：${result.tier.review} 个会话进入 Tier B 待复核队列，可在应用「待整理」中逐条决定。`,
      );
    }
  } finally {
    // CLI 只做资源清理，不复用 server 的 gracefulShutdown（后者带信号语义与进程退出）。
    for (const item of [...runtime.shutdownItems].reverse()) {
      try {
        await item.fn();
      } catch (error) {
        console.warn(`[chat-ingest] 清理 ${item.name} 失败：`, String(error));
      }
    }
  }
}

main().catch((error) => {
  console.error("[chat-ingest] 导入失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
