/**
 * 派生索引库的隔离与重建。
 *
 * `data/reply-retrieval.sqlite` 是**派生数据**：密钥由 `persons.sqlite` 的根密钥 + 
 * `data/reply-retrieval.salt` 经 HKDF 派生。只要 salt 被重建（例如清理数据时被删过一次）、
 * 或根密钥轮换过，旧索引就再也解不开 —— 表现为启动时 `openReplyRetrievalDb` 抛
 * `EncryptionKeyInvalidError`，进而「加密聊天历史上下文」永久不可用，
 * 任何勾选历史授权的自动回复都会在启动预检被暂停。
 *
 * 这里只做**重命名隔离**，绝不删除：人物库（真实数据）不受影响，隔离下来的旧索引留在旁边
 * 便于事后取证，新索引由 startup 的回填流程重建。
 *
 * @module @knowself/dsh-plugin/reply-index-recovery
 */

import { existsSync, renameSync } from "node:fs";

/** 派生索引库的三个文件后缀（主库 + WAL + 共享内存）。 */
const INDEX_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

export interface QuarantineResult {
  /** 成功重命名的原路径。 */
  moved: string[];
  /** 重命名失败的原路径（通常是宿主还占着文件）。 */
  failed: string[];
}

/**
 * 把无法解密的派生索引库及其旁文件重命名成 `<db>.broken-<timestamp>[...]`。
 *
 * @param dbPath - 派生索引主库路径（例如 `data/reply-retrieval.sqlite`）。
 * @param at - 隔离时间戳，建议已经过 `:`/`.` 替换，可直接用于文件名。
 * @returns 分别列出成功与失败的文件；调用方据此决定是重建还是提示手工处理。
 */
export function quarantineReplyIndex(dbPath: string, at: string): QuarantineResult {
  const moved: string[] = [];
  const failed: string[] = [];
  for (const suffix of INDEX_FILE_SUFFIXES) {
    const from = `${dbPath}${suffix}`;
    if (!existsSync(from)) continue;
    const to = `${dbPath}.broken-${at}${suffix}`;
    try {
      renameSync(from, to);
      moved.push(from);
    } catch {
      failed.push(from);
    }
  }
  return { moved, failed };
}

/** 把 ISO 时间压成可用作文件名后缀的形式（Windows 不允许 `:`）。 */
export function quarantineStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
