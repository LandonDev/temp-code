import { bundledLanguages, createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { TRANSCRIPT_CODE_THEME_NAME, transcriptCodeTheme } from "./transcriptCodeTheme";
import { createLanguageLoader } from "./highlightLanguages";

/**
 * Shiki off the main thread (ported from temp-code): the renderer posts
 * { id, code, lang } and gets { id, html } back. Unknown languages fall
 * back to plain text. One neutral theme whose colours are CSS variables
 * (transcriptCodeTheme.ts), so the markup follows the app's theme by itself.
 */

let highlighterP: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  // JS regex engine: workers inherit the document CSP, which has no
  // wasm-unsafe-eval, so oniguruma's WASM never instantiates here.
  // No grammar up front: each language's chunk (shiki ships one per
  // grammar) loads the first time a block asks for it (loadLanguage).
  highlighterP ??= createHighlighter({
    themes: [transcriptCodeTheme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((h) => (highlighter = h));
  return highlighterP;
}
let highlighter: Highlighter | null = null;

/** Each grammar's chunk loads the first time a block asks for it (highlightLanguages.ts). */
const languageFor = createLanguageLoader(
  {
    getLoadedLanguages: () => highlighter?.getLoadedLanguages() ?? [],
    loadLanguage: (grammar) => highlighter!.loadLanguage(grammar as never),
  },
  bundledLanguages,
);

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
  const { id, code, lang } = e.data;
  try {
    const h = await getHighlighter();
    const language = await languageFor(lang);
    const html = h.codeToHtml(code, {
      lang: language,
      theme: TRANSCRIPT_CODE_THEME_NAME,
    });
    // Lines are block elements in the transcript's CSS; the newlines shiki
    // puts between them would render as blank rows inside the <pre>.
    self.postMessage({ id, html: html.replace(/\n(?=<span class="line")/g, "") });
  } catch {
    self.postMessage({ id, html: null });
  }
};
