import type { Context } from "hono";
import type { SourceStored } from "@knowself/contracts";
import type { Ingestion } from "@knowself/ingestion";
import { inferMime } from "@knowself/ingestion";

export interface UploadDeps {
  ingestion: Ingestion;
  maxFileBytes: number;
}

export async function handleSourceUpload(deps: UploadDeps, c: Context): Promise<SourceStored> {
  const body = await c.req.parseBody();
  const file = body.file as File | undefined | null;
  const note = typeof body.note === "string" ? body.note : "";

  if (!file) {
    const err = new Error("No file provided") as Error & { code: string };
    err.code = "BAD_REQUEST";
    throw err;
  }

  if (file.size > deps.maxFileBytes) {
    const err = new Error("File too large") as Error & { code: string };
    err.code = "FILE_TOO_LARGE";
    throw err;
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const mime = (inferMime(file.name) ?? file.type) || "application/octet-stream";

  return deps.ingestion.createSource(
    {
      kind: "file",
      original_name: file.name,
      mime_type: mime as SourceStored["mime_type"],
      user_note: note,
      user_tags: [],
    },
    buf,
  );
}
