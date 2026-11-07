import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ISyncTransport } from "./transport";

export function createFileSystemTransport(): ISyncTransport {
  return {
    type: "filesystem",

    send(localZipPath: string, dest: string): Promise<void> {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const destFile = join(dest, `knowself-${ts}.zip`);
      mkdirSync(dest, { recursive: true });
      copyFileSync(localZipPath, destFile);
      return Promise.resolve();
    },

    receive(source: string, destDir: string): Promise<string> {
      const tmpName = `_sync-${randomUUID()}.zip`;
      const destPath = join(destDir, tmpName);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(source, destPath);
      return Promise.resolve(destPath);
    },

    ping(): Promise<boolean> {
      return Promise.resolve(existsSync("."));
    },
  };
}
