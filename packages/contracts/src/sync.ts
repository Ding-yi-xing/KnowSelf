import { z } from "zod";

export const SyncTransportType = z.enum(["filesystem", "webdav", "s3"]);
export const SyncConfig = z.object({
  transport: SyncTransportType,
  path: z.string(),
  conflict_strategy: z.enum(["last_write_wins", "manual"]).default("last_write_wins"),
  auto_sync_interval_min: z.number().int().min(0).default(0),
});
export const SyncConflict = z.object({
  table: z.string(),
  key: z.string(),
  local_updated_at: z.string(),
  remote_updated_at: z.string(),
  resolution: z.enum(["local_wins", "remote_wins", "unresolved"]),
});
export const SyncResult = z.object({
  uploaded: z.number().int(),
  downloaded: z.number().int(),
  conflicts: z.array(SyncConflict),
  errors: z.array(z.string()),
});
export const SyncErrorCode = z.enum([
  "TRANSPORT_UNREACHABLE",
  "AUTH_FAILED",
  "CORRUPT_SNAPSHOT",
  "SCHEMA_MISMATCH",
]);

export type SyncConfig = z.infer<typeof SyncConfig>;
export type SyncResult = z.infer<typeof SyncResult>;
export type SyncConflict = z.infer<typeof SyncConflict>;
export type SyncErrorCode = z.infer<typeof SyncErrorCode>;
