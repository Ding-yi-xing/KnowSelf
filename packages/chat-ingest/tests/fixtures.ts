/**
 * 合成 fixture（DESIGN-11 §9.1 铁律 2/3）：**全部手写合成，绝不含真实聊天内容**。
 * 人名只用 张三 / 李四 / 王五 / 赵六；wxid 只用 22 位固定字母形态。
 * 行尾按实测产物写成 CRLF（Python 文本模式输出）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NOW = "2026-09-10T10:00:00+08:00";

/** 单聊：我 / 张三，含图片占位与一条多行消息。 */
export const SINGLE_TXT = [
  "# 会话对象 : wxid_aaaaaaaaaaaa22",
  "# 显示名   : 张三",
  "# 类型     : 单聊",
  "# 消息数   : 5",
  "# 时间范围 : 2024-01-02 13:45 ~ 2024-01-02 13:48",
  "#",
  "---------- 2024-01-02 ----------",
  "[2024-01-02 13:45] 张三: 你好",
  "[13:45] 我: 在的",
  "[13:46] 张三: [图片]",
  "[13:47] 我: 收到",
  "[13:48] 张三: 结尾",
].join("\n");

/** 群聊：系统消息 / 未知发送者 / 各内容类型占位 / 续行。 */
export const GROUP_TXT = [
  "# 会话对象 : 12345678901@chatroom",
  "# 显示名   : 测试群",
  "# 类型     : 群聊",
  "# 消息数   : 8",
  "# 时间范围 : 2024-02-03 09:00 ~ 2024-02-03 09:07",
  "#",
  "---------- 2024-02-03 ----------",
  "[2024-02-03 09:00] 未知(sender=22): [系统消息]",
  "[09:01] 李四: [语音]",
  "[09:02] 我: [表情]",
  "[09:03] 王五: [类型244813135921]",
  "[09:04] 赵六: 第一行",
  "    第二行",
  "[09:05] 李四: [捂脸]",
  "[09:06] 王五: 重复",
  "[09:07] 王五: 重复",
].join("\n");

/** 建一个临时导出目录；文件名即 reader 的 `conversation_key` 兜底值。 */
export function makeExportDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "knowself-chat-ingest-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${content.replace(/\n/g, "\r\n")}\r\n`, "utf8");
  }
  return dir;
}

export function defaultExportDir(): string {
  return makeExportDir({
    "张三_13d6d3.txt": SINGLE_TXT,
    "测试群_aa79ea.txt": GROUP_TXT,
  });
}
