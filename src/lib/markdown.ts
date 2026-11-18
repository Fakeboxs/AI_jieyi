import DOMPurify from "dompurify";
import { marked } from "marked";
import renderMathInElement from "katex/contrib/auto-render";

marked.setOptions({ gfm: true, breaks: true });

const MATH_RE =
  /(\$\$[\s\S]*?\$\$)|(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))|(\$[^$\n]+\$)/g;

/** Pull LaTeX out before markdown parsing so `_` and `*` inside formulas survive. */
function protectMath(input: string) {
  const blocks: string[] = [];
  const text = input.replace(MATH_RE, (m) => {
    blocks.push(m);
    return `MATHPH${blocks.length - 1}`;
  });
  return { text, blocks };
}

function restoreMath(html: string, blocks: string[]) {
  let out = html;
  for (let i = blocks.length - 1; i >= 0; i--) {
    out = out.replaceAll(`MATHPH${i}`, blocks[i]);
  }
  return out;
}

/** Normalise `\begin{equation}`-style environments so KaTeX can render them. */
function normaliseEnvironments(md: string) {
  return md.replace(
    /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g,
    (_m, _env, body: string) => `\n$$\n${body.trim()}\n$$\n`,
  );
}

/** While SSE text is still arriving, hide a half-written math tail instead of
 *  rendering `$\frac{e^{S` as literal text. The full text is kept for copying. */
export function trimIncompleteMath(md: string): string {
  let mode: "display" | "inline" | null = null;
  let start = -1;
  let i = 0;
  while (i < md.length) {
    const ch = md[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (mode === null) {
      if (md.startsWith("$$", i)) {
        mode = "display";
        start = i;
        i += 2;
      } else if (md.startsWith("\\[", i)) {
        mode = "display";
        start = i;
        i += 2;
      } else if (md.startsWith("\\(", i)) {
        mode = "inline";
        start = i;
        i += 2;
      } else if (ch === "$") {
        mode = "inline";
        start = i;
        i += 1;
      } else {
        i += 1;
      }
    } else if (mode === "display") {
      if (md.startsWith("$$", i)) {
        mode = null;
        i += 2;
      } else if (md.startsWith("\\]", i)) {
        mode = null;
        i += 2;
      } else {
        i += 1;
      }
    } else if (ch === "$") {
      mode = null;
      i += 1;
    } else if (md.startsWith("\\)", i)) {
      mode = null;
      i += 2;
    } else {
      i += 1;
    }
  }
  return mode === null ? md : md.slice(0, start);
}

export function renderMarkdown(markdown: string, el: HTMLElement) {
  const { text, blocks } = protectMath(normaliseEnvironments(markdown));
  const raw = marked.parse(text, { async: false }) as string;
  const safe = DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target", "rel"],
    FORBID_TAGS: ["style", "iframe", "form", "input"],
  });
  el.innerHTML = restoreMath(safe, blocks);
  el.querySelectorAll("a[href]").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  renderMathInElement(el, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
      { left: "\\[", right: "\\]", display: true },
    ],
    throwOnError: false,
  });
}

/** Strips markdown/LaTeX down to something pasteable into chat or a doc. */
export function toPlainText(markdown: string) {
  return markdown
    .replace(MATH_RE, (m) => m.replace(/^\${1,2}|\\[()[\]]|\${1,2}$/g, "").trim())
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z]*\n?/g, "").trim())
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function summaryLine(markdown: string) {
  const first = toPlainText(markdown).split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.length > 96 ? `${first.slice(0, 96)}…` : first;
}
