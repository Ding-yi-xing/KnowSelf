/**
 * 简易 markdown 渲染器——将 markdown 文本转安全 HTML。
 * 仅支持 MVP 必需的标记：加粗、斜体、列表、代码块、链接（target=_blank）。
 * 不引入 markdown-it 运行时依赖，保持包体积最小。
 */

const ESCAPE_RE = /[&<>"]/g;
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]!);
}

/**
 * 将 markdown 文本渲染为 HTML 字符串。
 * 安全：输出 HTML 转义了用户输入，链接固定 target=_blank rel=noopener。
 */
export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // 代码块 ``` ... ```（先处理，避免内部标记被转义）
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    return `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
  });

  // 行内代码 `...`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // 加粗 **text** 或 __text__
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 斜体 *text* 或 _text_
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");

  // 无序列表 - item 或 * item
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");

  // 有序列表 1. item
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // 链接 [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // 标题 ### text / ## text / # text
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // 分割线 --- 或 ***
  html = html.replace(/^[-*]{3,}$/gm, "<hr />");

  // 段落：连续换行包 <p>
  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return "";
      // 跳过已包裹的块级元素
      if (
        trimmed.startsWith("<pre>") ||
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<hr") ||
        trimmed.startsWith("<li>")
      ) {
        // 把相邻 <li> 包进 <ul>
        if (trimmed.startsWith("<li>")) {
          const items = trimmed.split("\n").filter((l) => l.startsWith("<li>"));
          return `<ul>${items.join("")}</ul>`;
        }
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return html;
}
