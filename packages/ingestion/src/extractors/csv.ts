import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { ExtractorFailedError } from "../errors";
import { truncateText } from "./types";

const ACCEPTS: readonly SupportedMimeType[] = ["text/csv"];

export const csvExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const raw = typeof input === "string" ? input : input.toString("utf-8");
    const rows = parseCsvRows(raw);
    if (rows.length === 0) {
      throw new ExtractorFailedError("text/csv", "CSV has no data rows");
    }

    const markdown = rowsToMarkdown(rows);
    const { text } = truncateText(markdown, ctx.maxChars);

    return {
      text,
      sections: [],
      metadata: {
        title: ctx.originalName || undefined,
        word_count: text.split(/\s+/).filter(Boolean).length,
        extra: { row_count: rows.length },
      },
    };
  },
};

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    const next = csv[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(field.trim());
        field = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        current.push(field.trim());
        if (current.some((f) => f !== "")) {
          rows.push(current);
        }
        current = [];
        field = "";
        if (ch === "\r") i++;
      } else if (ch !== "\r") {
        field += ch;
      }
    }
  }

  // Last field + row
  current.push(field.trim());
  if (current.some((f) => f !== "")) {
    rows.push(current);
  }

  return rows;
}

function rowsToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";

  const colCount = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push("");
    return padded;
  });

  const header = normalized[0]!;
  const sep = header.map(() => "---");

  const lines: string[] = [];
  lines.push("| " + header.join(" | ") + " |");
  lines.push("| " + sep.join(" | ") + " |");
  for (let i = 1; i < normalized.length; i++) {
    lines.push("| " + normalized[i]!.join(" | ") + " |");
  }

  return lines.join("\n");
}
