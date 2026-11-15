import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

export interface DataPaths {
  rootDir: string;
  dataDir: string;
  profileDbPath: string;
  sourcesDir: string;
  exportsDir: string;
  modelsDir: string;
  conversationsDbPath: string;
  retrievalDbPath: string;
  replyRetrievalDbPath: string;
  replyRetrievalSaltPath: string;
  /** DESIGN-10 §8.1：persons.sqlite（person-store 唯一拥有者与唯一入口）。 */
  personsDbPath: string;
  /** DESIGN-16 §8.3 / §9.1：automation.sqlite 所在目录（独立库，automation 包独占）。 */
  automationDir: string;
  /** DESIGN-16 §8.3 / §9.1：automation.sqlite（明文，不进导出 / 不进同步）。 */
  automationDbPath: string;
}

export function getDataPaths(rootDir: string, dataSubdir?: string): DataPaths {
  const abs = (p: string) => resolve(rootDir, p);
  const d = dataSubdir ?? "data";

  return {
    rootDir,
    dataDir: abs(d),
    profileDbPath: abs(join(d, "profile.sqlite")),
    sourcesDir: abs(join(d, "sources")),
    exportsDir: abs(join(d, "exports")),
    modelsDir: abs(join(d, "models")),
    conversationsDbPath: abs(join(d, "conversations.sqlite")),
    retrievalDbPath: abs(join(d, "retrieval.sqlite")),
    replyRetrievalDbPath: abs(join(d, "reply-retrieval.sqlite")),
    replyRetrievalSaltPath: abs(join(d, "reply-retrieval.salt")),
    personsDbPath: abs(join(d, "persons.sqlite")),
    automationDir: abs(join(d, "automation")),
    automationDbPath: abs(join(d, "automation", "automation.sqlite")),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  const dirs = [
    paths.dataDir,
    paths.sourcesDir,
    paths.exportsDir,
    paths.modelsDir,
    paths.automationDir,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
