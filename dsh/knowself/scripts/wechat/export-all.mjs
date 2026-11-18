#!/usr/bin/env node
/**
 * 微信聊天记录导出：把**三个手工步骤**合成一条命令（W-35-A）。
 *
 * ## 它替代了什么
 * 以前「更新聊天记录」要依次手工跑：
 *   1. `find_key.py`          —— Frida spawn 微信抓主密钥 → `key.txt` / `key_meta.json`
 *   2. `decrypt_all.py`       —— SQLCipher4 逐页解密 → `decrypted/`
 *   3. `export_msgs.py`       —— 每会话一个 txt → `export/`
 * 然后把 `export/` 喂给应用的「导入聊天记录」。
 *
 * 本脚本负责 2+3（**不自动跑 1**：spawn 微信会打断用户正在用的微信）。
 * 取钥仍是显式动作，见 `--refresh-key` 的指引。
 *
 * ## 用法
 * ```
 * node scripts/wechat/export-all.mjs \
 *   [--out <dir>]          导出目录，默认 C:/dsh-lab/wechat-export/current（已存在则先清空）
 *   [--db <db_storage>]    默认读工具目录 local_config.py 的 DB_DIR
 *   [--decrypted <dir>]    解密中间产物，默认 <out>/../.decrypted（故意不放在 out 里）
 *   [--refresh-key]        打印取钥指引并退出（exit 2），**不会**自动 spawn 微信
 *   [--tool <dir>]         导出工具目录（默认见 DEFAULT_TOOL_DIR / WECHAT_EXPORT_TOOL_DIR）
 *   [--python <exe>]       指定 python 解释器（默认 py，其次 python）
 *   [--json]               只输出摘要 JSON（进度与告警走 stderr）
 * ```
 *
 * ## 退出码
 *   0  成功
 *   1  解密/导出失败（含产物缺失），或参数/环境问题
 *   2  缺密钥 / 要求 --refresh-key / 缺 Python 依赖 —— 都是「需要用户先做一件事」
 *
 * ## 为什么不自己猜 db 路径
 * `local_config.py` 是本机唯一权威来源（工具自身也这么读）。硬编码路径在换机/换号后
 * 会静默指向旧库，导出一份过期数据比报错更糟。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 导出工具默认位置（可用 --tool 或环境变量覆盖）。 */
const DEFAULT_TOOL_DIR =
  "C:/Users/40179/Documents/AllProjecks/wechat-extract-spike/wechat-chat-export-decrypt";

/** 默认导出目录（应用侧「导入聊天记录」直接指这里）。 */
const DEFAULT_OUT_DIR = "C:/dsh-lab/wechat-export/current";

/** 失败时回显子进程输出的尾部行数。 */
const TAIL_LINES = 20;

/** txt 里日期分隔行：`---------- 2026-11-13 ----------` */
const DATE_LINE = /^-{4,}\s*(\d{4}-\d{2}-\d{2})\s*-{4,}$/;
/**
 * txt 里消息行。真实产物有**两种**形态（同一次导出里并存）：
 *   - `[15:30] 我: 能用吧`              —— 常规行，只有时分；
 *   - `[2026-07-22 15:30] 我: 咋样`     —— 某些系统/跨天行带完整日期。
 * 第一版只认 `HH:MM:SS`，导致一条都匹配不到、最新时间退化成 `T00:00:00`（实测踩到）。
 */
const MSG_LINE = /^\[(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{2}:\d{2})(?::(\d{2}))?\]\s/;

/**
 * 解析命令行参数（不引依赖）。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Record<string, string | boolean>} 扁平参数表
 */
function parseArgs(argv) {
  const out = {};
  const takesValue = new Set(["out", "db", "decrypted", "tool", "python"]);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      out._ = raw;
      continue;
    }
    const [flag, inline] = raw.slice(2).split("=");
    if (takesValue.has(flag)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`参数 --${flag} 需要一个值`);
      }
      out[flag] = value;
      if (inline === undefined) i += 1;
    } else {
      out[flag] = true;
    }
  }
  return out;
}

/** 人类可读输出（--json 时全部改走 stderr，保证 stdout 只有一行 JSON）。 */
function createLogger(jsonMode) {
  return {
    info: (msg) => process.stderr.write(`${msg}\n`),
    step: (msg) => process.stderr.write(`\n▶ ${msg}\n`),
    warn: (msg) => process.stderr.write(`! ${msg}\n`),
    progress: (chunk) => process.stderr.write(chunk),
    /** 最终摘要：json 模式走 stdout，否则走 stderr（保持两种模式都只有一处产物）。 */
    summary: (line) => (jsonMode ? process.stdout.write(`${line}\n`) : process.stderr.write(`\n${line}\n`)),
  };
}

/**
 * 退出并给出「用户该做什么」的指引。
 * @param {number} code 退出码
 * @param {string} title 一行结论
 * @param {string[]} lines 具体步骤
 */
function fail(code, title, lines) {
  process.stderr.write(`\n✗ ${title}\n`);
  for (const line of lines) process.stderr.write(`  ${line}\n`);
  process.exit(code);
}

/**
 * 从 `local_config.py` 读 `DB_DIR`（本机权威来源）。
 * @param {string} toolDir 工具目录
 * @returns {string | null} 绝对路径；文件缺失或无该常量时 null
 */
function readDbDir(toolDir) {
  const file = join(toolDir, "local_config.py");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const match = /^\s*DB_DIR\s*=\s*r?["'](.+?)["']/m.exec(text);
  return match === null ? null : match[1].trim();
}

/**
 * 读取密钥：优先 `key_meta.json` 的 `password_hex`（`decrypt_all.py` 自动模式用的就是它），
 * 退回 `key.txt` 内容。
 * @param {string} toolDir 工具目录
 * @returns {{passwordHex: string, capturedAt: string | null, source: string}}
 */
function readKey(toolDir) {
  const metaPath = join(toolDir, "key_meta.json");
  const keyPath = join(toolDir, "key.txt");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const hex = typeof meta.password_hex === "string" ? meta.password_hex.trim() : "";
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return {
        passwordHex: hex.toLowerCase(),
        capturedAt: typeof meta.captured_at === "string" ? meta.captured_at : null,
        source: "key_meta.json",
      };
    }
  }
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, "utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return { passwordHex: hex.toLowerCase(), capturedAt: null, source: "key.txt" };
    }
  }
  return { passwordHex: "", capturedAt: null, source: "(无)" };
}

/**
 * 选 python 解释器：`--python` > env `WECHAT_EXPORT_PYTHON` > `py` > `python`。
 *
 * 为什么优先 `py`：本机 `python` 可能指向托管/沙箱解释器，往里装依赖既不合规也白装；
 * `py` 是用户自己的安装（Windows launcher）。
 * @param {Record<string, string | boolean>} args 参数表
 * @returns {string} 可执行名或绝对路径
 */
function pickPython(args) {
  if (typeof args.python === "string") return args.python;
  if (process.env.WECHAT_EXPORT_PYTHON) return process.env.WECHAT_EXPORT_PYTHON;
  return "py";
}

/**
 * 跑一个子进程，实时回显、收集输出。
 * @param {string} cmd 可执行
 * @param {string[]} argv 参数
 * @param {{cwd: string, echo: (chunk: string) => void}} options
 * @returns {Promise<{code: number, output: string}>}
 */
function run(cmd, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, argv, { cwd: options.cwd, windowsHide: true });
    let output = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      options.echo(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

/**
 * 只回显尾部若干行（失败步骤排错用）。
 * @param {string} output 子进程完整输出
 * @param {number} lines 行数
 * @returns {string} 尾部文本
 */
function tail(output, lines) {
  const all = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * 从文件尾部取一段「含至少一个日期分隔行」的文本。
 *
 * 为什么不能固定取尾部 8KB：某个会话在最后一天可能有几百条消息（> 8KB），
 * 那样尾段里根本没有日期分隔行，整个文件会被跳过 → 最新时间算少（实测踩到过）。
 * 因此按 8KB → 64KB → 256KB → 1MB → 全文 逐级放大，取第一个含日期行的片段。
 *
 * @param {string} file 文件路径
 * @returns {string} 片段文本
 */
function readTailWithDate(file) {
  const size = statSync(file).size;
  const buffer = readFileSync(file);
  for (const windowBytes of [8192, 65536, 262144, 1048576, size]) {
    const start = Math.max(0, size - windowBytes);
    const text = buffer.subarray(start).toString("utf8");
    if (DATE_LINE.test(text.split(/\r?\n/).map((line) => line.trim()).join("\n"))) return text;
    if (start === 0) break;
  }
  return buffer.toString("utf8");
}

/**
 * 统计目录里的 txt 并算最新一条消息时间。
 *
 * 只看每个文件**尾部 8KB**：会话内消息按时间递增，所以末尾的「日期分隔行 + 消息行」
 * 就是该会话最新一条；再取所有会话的最大值。这样避免把几百 MB 正文全读一遍。
 *
 * @param {string} dir 导出目录
 * @returns {{txtCount: number, newestMessageAt: string | null}}
 */
function summarizeExport(dir) {
  const names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".txt"));
  let newest = null;
  for (const name of names) {
    const file = join(dir, name);
    let text;
    try {
      text = readTailWithDate(file);
    } catch {
      continue;
    }
    let day = null;
    let clock = null;
    for (const line of text.split(/\r?\n/)) {
      const dateMatch = DATE_LINE.exec(line.trim());
      if (dateMatch !== null) {
        day = dateMatch[1];
        clock = null; // 换日之后的时间要重新取
        continue;
      }
      const msgMatch = MSG_LINE.exec(line);
      if (msgMatch === null) continue;
      // 带完整日期的行自带日期，优先用它（避免与上一条日期分隔行错配）
      if (msgMatch[1] !== undefined) day = msgMatch[1];
      clock = msgMatch[3] === undefined ? msgMatch[2] : `${msgMatch[2]}:${msgMatch[3]}`;
    }
    if (day === null) continue;
    // 当天没有可解析消息行时用 00:00:00 兜底（至少能反映"这一天有内容"）
    const stamp = `${day}T${clock ?? "00:00:00"}`;
    if (newest === null || stamp > newest) newest = stamp;
  }
  return { txtCount: names.length, newestMessageAt: newest };
}

/** 主流程。 */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(1, `参数错误：${err instanceof Error ? err.message : String(err)}`, [
      "用法：node scripts/wechat/export-all.mjs [--out <dir>] [--db <db_storage>] [--decrypted <dir>] [--refresh-key] [--json]",
    ]);
  }
  const jsonMode = args.json === true;
  const log = createLogger(jsonMode);
  const startedAt = Date.now();

  // ── 工具目录与脚本存在性 ─────────────────────────────────────────────
  const toolDir = resolve(
    typeof args.tool === "string"
      ? args.tool
      : (process.env.WECHAT_EXPORT_TOOL_DIR ?? DEFAULT_TOOL_DIR),
  );
  for (const required of ["decrypt_all.py", "export_msgs.py"]) {
    if (!existsSync(join(toolDir, required))) {
      fail(1, `找不到导出工具脚本：${join(toolDir, required)}`, [
        "用 --tool <dir> 指定 wechat-chat-export-decrypt 目录，或设置 WECHAT_EXPORT_TOOL_DIR",
      ]);
    }
  }

  // ── 密钥：**绝不自动 spawn 微信** ────────────────────────────────────
  if (args["refresh-key"] === true) {
    fail(2, "需要重新抓密钥（--refresh-key 只打印指引，不会替你操作微信）", [
      "1) 完全退出微信（托盘右键退出，任务管理器里确认没有 WeChat.exe）",
      `2) 在 ${toolDir} 下运行：py find_key.py`,
      "3) 它会启动微信并 hook 取主密钥，写出 key.txt / key_meta.json",
      "4) 再跑本命令（不要带 --refresh-key）",
      "说明：微信必须先退出——运行中的微信无法被 spawn+hook；这一步会打断你手头的微信使用。",
    ]);
  }
  const skipDecrypt = args["skip-decrypt"] === true;
  /** @type {{ passwordHex: string, capturedAt: number | null, source: string } | null} */
  let key = null;

  // ── 密钥：只有「自己解密」这一步需要；dsh 驱动路径（--skip-decrypt）已自带密钥 ──
  //
  // 2026-11-17：dsh 的导入流程改为从运行中的微信进程读密钥、自己解出明文，
  // 再带 `--skip-decrypt` 调用本脚本。此时 toolDir 下没有 key.txt/key_meta.json 是
  // 正常状态，不能再当成「缺密钥」直接 fail(2)。
  if (!skipDecrypt) {
    key = readKey(toolDir);
    if (key.passwordHex === "") {
      fail(2, "没有可用的密钥（key.txt / key_meta.json 缺失或格式不对）", [
        `在 ${toolDir} 下：先完全退出微信，再运行 py find_key.py`,
        "拿到密钥后重跑本命令；详见 runbook：docs/units/desktop/runbook-export.md",
        "（dsh 应用内导入不读 key 文件：它会从运行中的微信直接取密钥，无需这一步）",
      ]);
    }
    if (key.capturedAt === null) {
      log.warn(
        `${key.source} 没有 captured_at 字段（该工具版本不写），无法判断密钥新旧；` +
          "先按可用处理，若解密失败请按 --refresh-key 的指引重新取钥。",
      );
    }
  }

  // ── 目录：out 先清空；decrypted 放 out 的兄弟目录 ─────────────────────
  const outDir = resolve(typeof args.out === "string" ? args.out : DEFAULT_OUT_DIR);
  const decryptedDir = resolve(
    typeof args.decrypted === "string" ? args.decrypted : join(dirname(outDir), ".decrypted"),
  );
  const depth = outDir.split(/[\\/]/).filter((part) => part !== "").length;
  if (depth < 2 || decryptedDir === outDir) {
    fail(1, `--out 目录过于宽泛或有误，拒绝清空：${outDir}`, [
      "请给一个至少两级的具体目录，例如 C:/dsh-lab/wechat-export/current",
    ]);
  }
  if (skipDecrypt) {
    // 输入目录由 dsh 驱动解好（已含 WAL），绝不能清空。
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    if (!existsSync(decryptedDir)) {
      fail(1, `--skip-decrypt 需要已存在的明文目录：${decryptedDir}`, []);
    }
  } else {
    for (const dir of [outDir, decryptedDir]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  }

  // ── db 路径 ──────────────────────────────────────────────────────────
  const dbDir = typeof args.db === "string" ? resolve(args.db) : readDbDir(toolDir);
  if (dbDir === null || dbDir === "") {
    fail(1, "拿不到微信 db_storage 路径", [
      `local_config.py 里没有 DB_DIR（${join(toolDir, "local_config.py")}），`,
      "或用 --db <...\\xwechat_files\\wxid_xxx\\db_storage> 显式指定",
    ]);
  }
  if (!existsSync(dbDir)) {
    fail(1, `db_storage 目录不存在：${dbDir}`, [
      "微信可能换了账号/安装路径；用 --db 指定正确目录",
    ]);
  }

  const python = pickPython(args);
  log.info(`工具目录 : ${toolDir}`);
  log.info(`db 目录  : ${dbDir}`);
  log.info(`解密到   : ${decryptedDir}`);
  log.info(`导出到   : ${outDir}`);
  log.info(`解释器   : ${python}`);

  // ── 预检 Python 依赖（缺依赖要给 pip 命令，而不是让用户看半截堆栈）──
  if (!skipDecrypt) {
    let depCheck;
    try {
      depCheck = await run(python, ["-c", "import Crypto; print('pycryptodome:' + Crypto.__version__)"], {
        cwd: toolDir,
        echo: () => {},
      });
    } catch (err) {
      fail(1, `无法运行 python 解释器「${python}」：${err instanceof Error ? err.message : String(err)}`, [
        "用 --python <exe> 指定，例如 --python C:/Data/Python/Python314/python.exe",
      ]);
    }
    if (depCheck.code !== 0) {
      fail(2, "缺 Python 依赖：pycryptodome（解密 SQLCipher 需要）", [
        `安装：${python} -m pip install pycryptodome`,
        "（若 --refresh-key 取钥也失败，再装 frida：py -m pip install frida frida-tools）",
        "本脚本不会自动安装依赖，也不会装到全局之外的任何位置。",
      ]);
    }
    log.info(depCheck.output.trim());
  }

  // ── 步骤 1/2：解密（或跳过：dsh 已用驱动解出明文）─────────────────
  if (skipDecrypt) {
    log.step("步骤 1/2：跳过解密（输入目录已是明文）");
  } else {
    log.step("步骤 1/2：解密数据库（decrypt_all.py）");
    const decrypt = await run(python, ["decrypt_all.py", key.passwordHex, dbDir, decryptedDir], {
      cwd: toolDir,
      echo: (chunk) => log.progress(chunk),
    });
    if (decrypt.code !== 0) {
      log.info(`\n--- decrypt_all.py 输出尾部（${TAIL_LINES} 行）---`);
      log.info(tail(decrypt.output, TAIL_LINES));
      fail(1, `解密失败（exit ${decrypt.code}）`, [
        "常见原因：微信在运行 / 密钥过期 / db_storage 路径不对",
        "若密钥过期：完全退出微信后 py find_key.py 重新取钥，再重跑本命令",
      ]);
    }
  }
  const decryptedFiles = readdirSync(decryptedDir).filter((name) => name.endsWith(".db"));
  if (decryptedFiles.length === 0) {
    fail(1, "解密步骤退出码为 0 但产物为空（decrypted 目录里没有 .db）", [
      `检查 ${decryptedDir}；必要时用 --decrypted 换个目录重跑`,
    ]);
  }
  log.info(`✓ 解密完成：${decryptedFiles.length} 个 .db`);

  // ── 步骤 2/2：导出 ───────────────────────────────────────────────────
  log.step("步骤 2/2：导出为每会话 txt（export_msgs.py）");
  const exported = await run(python, ["export_msgs.py", decryptedDir, outDir], {
    cwd: toolDir,
    echo: (chunk) => log.progress(chunk),
  });
  if (exported.code !== 0) {
    log.info(`\n--- export_msgs.py 输出尾部（${TAIL_LINES} 行）---`);
    log.info(tail(exported.output, TAIL_LINES));
    fail(1, `导出失败（exit ${exported.code}）`, [
      "若是「未找到 message_*.db」→ 解密产物不完整，先看上一步",
    ]);
  }

  const { txtCount, newestMessageAt } = summarizeExport(outDir);
  if (txtCount === 0) {
    fail(1, "导出步骤退出码为 0 但目录里没有 txt", [`检查 ${outDir}`]);
  }

  const summary = {
    txt_count: txtCount,
    newest_message_at: newestMessageAt,
    out_dir: outDir,
    elapsed_ms: Date.now() - startedAt,
  };
  log.summary(JSON.stringify(summary));
  if (!jsonMode) {
    log.info(`\n✓ 完成：${txtCount} 个会话 txt，最新消息 ${newestMessageAt ?? "(未知)"}`);
    log.info(`  把这个目录喂给应用的「导入聊天记录」：${outDir}`);
    log.info(`  解密中间产物保留在：${decryptedDir}（排错用，可随时删）`);
  }
}

main().catch((err) => {
  fail(1, `未预期错误：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, [
    "请把这段输出连同 docs/units/desktop/runbook-export.md 一起反馈",
  ]);
});
