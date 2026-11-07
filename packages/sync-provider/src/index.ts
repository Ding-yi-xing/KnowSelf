import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { exportProfile, importProfile } from "@knowself/profile-store";
import type { ProfileStore, ProfileDb } from "@knowself/profile-store";
import type { SyncConfig, SyncResult } from "@knowself/contracts";
import type { ISyncTransport } from "./transport";
import { createFileSystemTransport } from "./filesystem";
import { SyncError } from "./errors";

function createTransport(config: SyncConfig): ISyncTransport {
  if (config.transport === "filesystem") return createFileSystemTransport();
  throw new SyncError("TRANSPORT_UNREACHABLE", `不支持的传输类型: ${config.transport}`);
}

function profileDbFromStore(ps: ProfileStore): ProfileDb {
  return ps as unknown as ProfileDb;
}

export function createSyncProvider(config: SyncConfig) {
  const transport = createTransport(config);

  return {
    async sync(profileStore: ProfileStore): Promise<SyncResult> {
      const errors: string[] = [];

      const ok = await transport.ping();
      if (!ok) {
        throw new SyncError("TRANSPORT_UNREACHABLE", "同步介质不可用");
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const workDir = join(tmpdir(), `knowself-sync-${ts}`);
      mkdirSync(workDir, { recursive: true });

      const localZipDir = join(workDir, "local");
      mkdirSync(localZipDir, { recursive: true });

      const db = profileDbFromStore(profileStore);
      const buf = await exportProfile(
        { db, sourcesDir: "", exportsDir: localZipDir },
        { format: "sqlite", include_sources: false },
      );
      const localZip = join(localZipDir, buf.download_path);

      let remoteZip: string | null = null;
      try {
        remoteZip = await transport.receive(config.path, join(workDir, "remote"));
      } catch {
        // no remote snapshot yet — first sync is upload-only
      }

      await transport.send(localZip, config.path);

      const uploaded = 1;
      let downloaded = 0;
      const conflicts: SyncResult["conflicts"] = [];

      if (remoteZip) {
        downloaded = 1;
        const dryResult = await importProfile(db, remoteZip, "dry-run");
        for (const t of Object.keys(dryResult.imported.tables)) {
          const cnt = dryResult.imported.tables[t] ?? 0;
          if (cnt > 0) {
            conflicts.push({
              table: t,
              key: t,
              local_updated_at: "",
              remote_updated_at: "",
              resolution: "unresolved",
            });
          }
        }
      }

      return { uploaded, downloaded, conflicts, errors };
    },

    async import(profileStore: ProfileStore): Promise<SyncResult> {
      const ok = await transport.ping();
      if (!ok) {
        throw new SyncError("TRANSPORT_UNREACHABLE", "同步介质不可用");
      }

      const workDir = join(tmpdir(), `knowself-sync-import-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      const remoteZip = await transport.receive(config.path, workDir);
      const db = profileDbFromStore(profileStore);
      const result = await importProfile(db, remoteZip, "merge");

      return {
        uploaded: 0,
        downloaded: 1,
        conflicts: result.conflicts.map((c) => ({
          table: c.table,
          key: c.key,
          local_updated_at: c.local,
          remote_updated_at: c.remote,
          resolution:
            c.resolution === "skipped"
              ? "unresolved"
              : (c.resolution as "local_wins" | "remote_wins" | "unresolved"),
        })),
        errors: [],
      };
    },
  };
}
