import { createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * Shiki off the main thread (docs/PLAN.md M3): the renderer posts
 * { id, code, lang } and gets { id, html } back. Unknown languages fall
 * back to plaintext.
 */

const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'python',
  'java',
  'go',
  'rust',
  'html',
  'css',
  'sql',
  'yaml',
  'markdown',
  'diff'
]

let highlighterP: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  // JS regex engine: workers inherit the document CSP, which has no
  // wasm-unsafe-eval — oniguruma's WASM never instantiates here.
  highlighterP ??= createHighlighter({
    themes: ['github-light', 'one-dark-pro'],
    langs: LANGS,
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  return highlighterP
}

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
  const { id, code, lang } = e.data
  try {
    const h = await getHighlighter()
    const language = h.getLoadedLanguages().includes(lang) ? lang : 'text'
    // Both palettes in one pass; main.css flips to --shiki-dark under .dark.
    const html = h.codeToHtml(code, {
      lang: language,
      themes: { light: 'github-light', dark: 'one-dark-pro' },
      defaultColor: 'light'
    })
    self.postMessage({ id, html })
  } catch {
    self.postMessage({ id, html: null })
  }
}
