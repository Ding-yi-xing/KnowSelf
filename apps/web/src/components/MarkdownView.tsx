/**
 * MarkdownView — 将 markdown 文本渲染为 HTML。
 */
import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownViewProps {
  text: string;
  className?: string;
}

export function MarkdownView({ text, className }: MarkdownViewProps) {
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <div
      className={`prose prose-sm dark:prose-invert max-w-none ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
