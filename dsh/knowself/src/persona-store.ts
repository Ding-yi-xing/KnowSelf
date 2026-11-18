/**
 * 人格文件落盘（服务端专用，只在 `services.ts` 引用）。
 *
 * 参考 OpenClaw / SillyTavern 的做法：人格是**可编辑的纯文本文件**，不是硬编码在代码里。
 * 改完下次启动回复任务就生效，不需要重新构建、也不需要重启 App。
 *
 * 位置：`<dataDir>/personas/<contact_id>.json`。用户手改这个文件即可调整口吻；
 * 删掉它就会在下次任务启动时重新生成。
 *
 * @module @knowself/dsh-plugin/persona-store
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserializeReplyPersona, type ReplyPersona } from "./wechat-persona.js";

/** 人格目录；首次调用时创建。 */
export function personaDir(dataDir: string): string {
  const dir = join(dataDir, "personas");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把 contact_id 变成安全文件名（只留字母数字下划线横线，杜绝路径穿越）。 */
function personaFileName(contactId: string): string {
  const safe = contactId.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe === "" ? "unknown" : safe}.json`;
}

/** 完整路径（不创建目录，便于测试与日志）。 */
export function personaFilePath(dataDir: string, contactId: string): string {
  return join(dataDir, "personas", personaFileName(contactId));
}

/**
 * 读盘。文件不存在 / 空 / JSON 坏 / 结构不合法 → null（调用方重新生成）。
 */
export function loadPersonaFromDisk(dataDir: string, contactId: string): ReplyPersona | null {
  try {
    const raw = readFileSync(personaFilePath(dataDir, contactId), "utf8");
    if (raw.trim() === "") return null;
    return deserializeReplyPersona(raw);
  } catch {
    return null;
  }
}

/**
 * 写盘。失败只记日志，不影响本轮回复。
 *
 * @returns 是否写成功（测试用）。
 */
export function savePersonaToDisk(dataDir: string, contactId: string, persona: ReplyPersona): boolean {
  try {
    personaDir(dataDir);
    writeFileSync(personaFilePath(dataDir, contactId), JSON.stringify(persona, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
