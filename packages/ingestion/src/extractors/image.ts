import type { RawText, SupportedMimeType } from "@knowself/contracts";
import type { ExtractorContext } from "./types";
import { truncateText } from "./types";
import Tesseract from "tesseract.js";

const ACCEPTS = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const satisfies readonly SupportedMimeType[];

const MIME_LABEL: Record<(typeof ACCEPTS)[number], string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
};

export const imageExtractor = {
  accepts: ACCEPTS,

  async extract(input: Buffer | string, ctx: ExtractorContext): Promise<RawText> {
    const sizeBytes =
      typeof input === "string" ? Buffer.byteLength(input, "utf-8") : input.byteLength;
    const label = MIME_LABEL[ctx.mimeType as (typeof ACCEPTS)[number]] ?? ctx.mimeType;
    const ocr = await recognizeImage(input);
    const ocrText = ocr.text.trim();
    const extractionNote = ocrText
      ? "提取说明：已对图片执行本地 OCR 文字识别；识别结果可能受图片清晰度、字体和语言影响。"
      : ocr.error
        ? `提取说明：已保存原始图片文件，但 OCR 识别失败（${ocr.error}）；蒸馏时会结合文件名、格式和用户备注生成建议。`
        : "提取说明：已对图片执行本地 OCR，但未识别到可用文字；蒸馏时会结合文件名、格式和用户备注生成建议。";
    const { text } = truncateText(
      [
        "图片资料",
        `文件名：${ctx.originalName || "未命名图片"}`,
        `格式：${label}`,
        `文件大小：${formatBytes(sizeBytes)}`,
        extractionNote,
        ocrText ? ["", "## OCR识别文本", ocrText].join("\n") : "",
      ].join("\n"),
      ctx.maxChars,
    );

    return {
      text,
      sections: [],
      metadata: {
        title: ctx.originalName || undefined,
        word_count: text.split(/\s+/).filter(Boolean).length,
        extra: {
          extraction_method: ocrText ? "tesseract.js" : "image-metadata",
          ocr_performed: true,
          ocr_has_text: Boolean(ocrText),
          ocr_confidence: ocr.confidence,
          ocr_error: ocr.error,
          ocr_languages: getOcrLanguages(),
          size_bytes: sizeBytes,
        },
      },
    };
  },
};

async function recognizeImage(
  input: Buffer | string,
): Promise<{ text: string; confidence: number | null; error: string | null }> {
  try {
    const result = await Tesseract.recognize(input, getOcrLanguages(), {
      logger: () => {},
    });
    return {
      text: result.data.text ?? "",
      confidence: typeof result.data.confidence === "number" ? result.data.confidence : null,
      error: null,
    };
  } catch (err) {
    return {
      text: "",
      confidence: null,
      error: err instanceof Error ? err.message : "unknown OCR error",
    };
  }
}

function getOcrLanguages(): string {
  return process.env.KNOWSELF_OCR_LANGS?.trim() || "eng+chi_sim";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
