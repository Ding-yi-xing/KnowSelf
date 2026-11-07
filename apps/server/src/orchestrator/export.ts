import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { ExportFormat } from "@knowself/contracts";

export interface ExportDeps {
  exportsDir: string;
  dataDir: string;
}

export async function streamExport(deps: ExportDeps): Promise<{
  stream: ReadableStream<Uint8Array>;
  exportId: string;
  fileName: string;
}> {
  const exportId = randomUUID();
  const fileName = `export-${exportId}.zip`;
  mkdirSync(deps.exportsDir, { recursive: true });

  const encoder = new TextEncoder();
  const content = JSON.stringify({
    exported_at: new Date().toISOString(),
    format: "json" as ExportFormat,
    note: "Full export via /api/profile/export",
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(content));
      controller.close();
    },
  });

  return { stream, exportId, fileName };
}

export function cleanupExports(exportsDir: string, maxAgeMs: number = 30 * 60 * 1000): void {
  if (!existsSync(exportsDir)) return;

  const now = Date.now();
  try {
    for (const name of readdirSync(exportsDir)) {
      if (!name.startsWith("export-")) continue;
      const full = join(exportsDir, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          unlinkSync(full);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip cleanup errors */
  }
}
