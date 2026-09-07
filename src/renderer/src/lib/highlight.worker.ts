import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { darcula, intellijLight } from "./intellijTheme";

/**
 * Shiki off the main thread (ported from temp-code): the renderer posts
 * { id, code, lang } and gets { id, html } back. Unknown languages fall
 * back to plain text. Both palettes land in one pass; index.css flips the
 * `--shiki-light` variables in under `html.theme-light`.
 */

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "python",
  "java",
  "go",
  "rust",
  "html",
  "css",
  "sql",
  "yaml",
  "markdown",
  "diff",
];

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  golang: "go",
  jsonc: "json",
};

let highlighterP: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  // JS regex engine: workers inherit the document CSP, which has no
  // wasm-unsafe-eval, so oniguruma's WASM never instantiates here.
  highlighterP ??= createHighlighter({
    themes: [intellijLight, darcula],
    langs: LANGS,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterP;
}

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
  const { id, code, lang } = e.data;
  try {
    const h = await getHighlighter();
    const wanted = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
    const language = h.getLoadedLanguages().includes(wanted) ? wanted : "text";
    const html = h.codeToHtml(code, {
      lang: language,
      themes: { light: "intellij-light", dark: "darcula" },
      defaultColor: "dark",
    });
    // Lines are block elements in the transcript's CSS; the newlines shiki
    // puts between them would render as blank rows inside the <pre>.
    self.postMessage({ id, html: html.replace(/\n(?=<span class="line")/g, "") });
  } catch {
    self.postMessage({ id, html: null });
  }
};
