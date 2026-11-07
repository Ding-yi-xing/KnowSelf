import type { ExtractorContext } from "./types";
import type { SupportedMimeType, RawText } from "@knowself/contracts";
import { ExtractorFailedError } from "../errors";
import { truncateText } from "./types";
import ExcelJS from "exceljs";

const ACCEPTS: readonly SupportedMimeType[] = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export const xlsxExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : Buffer.from(input);
    const workbook = new ExcelJS.Workbook();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(buf as any);
    } catch (err) {
      throw new ExtractorFailedError(
        ACCEPTS[0]!,
        err instanceof Error ? err.message : "exceljs failed to parse xlsx",
      );
    }

    const parts: string[] = [];
    let sheetCount = 0;

    workbook.eachSheet((sheet) => {
      if (sheet.rowCount === 0) return;
      sheetCount++;

      parts.push(`## ${sheet.name}`);
      const rows: string[][] = [];
      sheet.eachRow((row) => {
        const values: string[] = [];
        row.eachCell((cell) => {
          values.push(cell.text ?? "");
        });
        if (values.some((v) => v !== "")) {
          rows.push(values);
        }
      });

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length));
        const header = rows[0]!;
        const sep = header.map(() => "---");
        parts.push("| " + header.join(" | ") + " |");
        parts.push("| " + sep.join(" | ") + " |");
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i]!;
          while (r.length < colCount) r.push("");
          parts.push("| " + r.join(" | ") + " |");
        }
      }
    });

    if (sheetCount === 0) {
      throw new ExtractorFailedError(ACCEPTS[0]!, "XLSX has no non-empty sheets");
    }

    const markdown = parts.join("\n\n");
    const { text } = truncateText(markdown, ctx.maxChars);

    return {
      text,
      sections: [],
      metadata: {
        title: ctx.originalName || undefined,
        word_count: text.split(/\s+/).filter(Boolean).length,
        extra: { sheet_count: sheetCount },
      },
    };
  },
};
