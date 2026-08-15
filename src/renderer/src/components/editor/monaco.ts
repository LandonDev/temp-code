import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/scss/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/kotlin/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/python/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { createHighlighter, bundledThemes, type ThemeRegistrationAny } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { shikiToMonaco } from '@shikijs/monaco'

/**
 * All Monaco wiring in one module (docs/PLAN-3.md M11, the electron-vite
 * risk contained): worker environment, language registration, shiki
 * TextMate tokenization — the same grammars the transcript's code blocks
 * use — and themes generated from our CSS tokens at startup and on theme
 * flip. This module is only ever imported lazily (the first file surface
 * pulls it in), never on app start.
 */

export { monaco }

// The base editor worker is the only worker we ship: language smarts come
// from the LSP pool, tokenization from shiki on the main thread.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// ── extra languages the definitions bundle lacks or splits wrong ─────
// tsx/jsx get their own ids so shiki's dedicated grammars paint them and
// the LSP client can map them to typescriptreact/javascriptreact.

const BRACKET_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string'] },
    { open: '`', close: '`', notIn: ['string', 'comment'] }
  ]
}

// json has no basic-language in monaco (its coloring lived in the json
// language service, which we deliberately don't ship) — shiki paints it.
for (const [id, exts] of [
  ['tsx', ['.tsx']],
  ['jsx', ['.jsx']],
  ['groovy', ['.gradle', '.groovy']],
  ['json', ['.json', '.jsonc']]
] as const) {
  monaco.languages.register({ id, extensions: [...exts] })
  monaco.languages.setLanguageConfiguration(id, BRACKET_CONFIG)
}

/** monaco language id for a path — models are created with this. */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const ext = name.slice(name.lastIndexOf('.'))
  const MAP: Record<string, string> = {
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'jsx',
    '.json': 'json',
    '.jsonc': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.gradle': 'groovy',
    '.groovy': 'groovy',
    '.xml': 'xml',
    '.pom': 'xml',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.md': 'markdown',
    '.properties': 'ini',
    '.ini': 'ini',
    '.toml': 'ini',
    '.sql': 'sql',
    '.sh': 'shell',
    '.zsh': 'shell',
    '.bash': 'shell',
    '.py': 'python'
  }
  return MAP[ext] ?? 'plaintext'
}

// ── themes from tokens ───────────────────────────────────────────────

let colorProbe: CanvasRenderingContext2D | null = null

/** Resolve any CSS color (oklch, hsl, var) to #rrggbbaa via a canvas. */
function cssToHex(css: string): string | undefined {
  if (!css.trim()) return undefined
  colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!colorProbe) return undefined
  colorProbe.clearRect(0, 0, 1, 1)
  colorProbe.fillStyle = '#000'
  colorProbe.fillStyle = css.trim()
  colorProbe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ''}`
}

/** Read one mode's palette. Toggles .dark on <html> synchronously while
 *  reading — no frame renders in between, so nothing flashes. */
function readPalette(dark: boolean): Record<string, string> {
  const html = document.documentElement
  const had = html.classList.contains('dark')
  html.classList.toggle('dark', dark)
  const cs = getComputedStyle(html)
  const v = (name: string): string => cs.getPropertyValue(name)
  const withAlpha = (name: string, alpha: number): string => {
    const hex = cssToHex(v(name)) ?? '#888888'
    return (
      hex.slice(0, 7) +
      Math.round(alpha * 255)
        .toString(16)
        .padStart(2, '0')
    )
  }
  const palette: Record<string, string> = {
    'editor.background': cssToHex(v('--background'))!,
    'editor.foreground': cssToHex(v('--foreground'))!,
    'editorGutter.background': cssToHex(v('--background'))!,
    'editorLineNumber.foreground': cssToHex(v('--faint'))!,
    'editorLineNumber.activeForeground': cssToHex(v('--muted-foreground'))!,
    'editor.lineHighlightBackground': cssToHex(v('--accent'))!,
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': withAlpha('--brand', 0.22),
    'editor.inactiveSelectionBackground': withAlpha('--brand', 0.12),
    'editorCursor.foreground': cssToHex(v('--foreground'))!,
    'editorWhitespace.foreground': cssToHex(v('--hairline'))!,
    'editorIndentGuide.background1': cssToHex(v('--hairline'))!,
    'editorIndentGuide.activeBackground1': cssToHex(v('--border-strong'))!,
    'editorBracketMatch.background': '#00000000',
    'editorBracketMatch.border': cssToHex(v('--border-strong'))!,
    'editorWidget.background': cssToHex(v('--popover'))!,
    'editorWidget.foreground': cssToHex(v('--foreground'))!,
    'editorWidget.border': cssToHex(v('--border-strong'))!,
    'editorSuggestWidget.background': cssToHex(v('--popover'))!,
    'editorSuggestWidget.border': cssToHex(v('--border-strong'))!,
    'editorSuggestWidget.selectedBackground': cssToHex(v('--accent'))!,
    'editorSuggestWidget.highlightForeground': cssToHex(v('--brand'))!,
    'editorHoverWidget.background': cssToHex(v('--popover'))!,
    'editorHoverWidget.border': cssToHex(v('--border-strong'))!,
    'input.background': cssToHex(v('--input'))!,
    'input.border': cssToHex(v('--border-strong'))!,
    'inputOption.activeBorder': cssToHex(v('--brand'))!,
    'list.hoverBackground': cssToHex(v('--accent'))!,
    'list.activeSelectionBackground': cssToHex(v('--accent'))!,
    'list.activeSelectionForeground': cssToHex(v('--foreground'))!,
    'scrollbarSlider.background': withAlpha('--foreground', 0.08),
    'scrollbarSlider.hoverBackground': withAlpha('--foreground', 0.16),
    'scrollbarSlider.activeBackground': withAlpha('--foreground', 0.2),
    'editorError.foreground': cssToHex(v('--destructive'))!,
    'editorWarning.foreground': cssToHex(v('--warning'))!,
    'editorInfo.foreground': cssToHex(v('--info'))!,
    'editorGhostText.foreground': cssToHex(v('--faint'))!,
    'diffEditor.insertedTextBackground': withAlpha('--success', 0.14),
    'diffEditor.removedTextBackground': withAlpha('--destructive', 0.14),
    'diffEditor.insertedLineBackground': withAlpha('--success', 0.07),
    'diffEditor.removedLineBackground': withAlpha('--destructive', 0.07),
    'diffEditorGutter.insertedLineBackground': withAlpha('--success', 0.07),
    'diffEditorGutter.removedLineBackground': withAlpha('--destructive', 0.07),
    'peekView.border': cssToHex(v('--border-strong'))!,
    'peekViewEditor.background': cssToHex(v('--background'))!,
    'peekViewResult.background': cssToHex(v('--popover'))!,
    'peekViewTitle.background': cssToHex(v('--popover'))!
  }
  html.classList.toggle('dark', had)
  return palette
}

// ── the highlighter (lazy singleton) ─────────────────────────────────

const EDITOR_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'scss',
  'html',
  'java',
  'kotlin',
  'groovy',
  'xml',
  'yaml',
  'markdown',
  'ini',
  'sql',
  'shellscript',
  'python',
  'diff'
]

let readyP: Promise<void> | null = null

/** Load grammars + register tc-light/tc-dark; idempotent. */
export function monacoReady(): Promise<void> {
  readyP ??= (async () => {
    const [{ default: light }, { default: dark }] = await Promise.all([
      bundledThemes['github-light'](),
      bundledThemes['one-dark-pro']()
    ])
    const tcLight: ThemeRegistrationAny = {
      ...light,
      name: 'tc-light',
      colors: { ...light.colors, ...readPalette(false) }
    }
    const tcDark: ThemeRegistrationAny = {
      ...dark,
      name: 'tc-dark',
      colors: { ...dark.colors, ...readPalette(true) }
    }
    // The JS regex engine: no WASM, so the renderer CSP stays wasm-free
    // (oniguruma's WebAssembly.instantiate is blocked by script-src 'self').
    const highlighter = await createHighlighter({
      themes: [tcLight, tcDark],
      langs: EDITOR_LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true })
    })
    shikiToMonaco(highlighter, monaco)
    applyEditorTheme()
    // Follow the app's theme flips (store.setTheme toggles .dark on <html>).
    new MutationObserver(applyEditorTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })
  })()
  return readyP
}

export function applyEditorTheme(): void {
  monaco.editor.setTheme(
    document.documentElement.classList.contains('dark') ? 'tc-dark' : 'tc-light'
  )
}

// ── shared editor options (DESIGN.md: quiet chrome, buffer is the hero) ──

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: "'Geist Mono', 'SF Mono', ui-monospace, Menlo, monospace",
  fontSize: 12,
  lineHeight: 19,
  minimap: { enabled: false },
  glyphMargin: false,
  folding: true,
  showFoldingControls: 'mouseover',
  renderLineHighlight: 'line',
  renderLineHighlightOnlyWhenFocus: true,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  automaticLayout: true,
  padding: { top: 10, bottom: 10 },
  stickyScroll: { enabled: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  guides: { indentation: true, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  occurrencesHighlight: 'singleFile',
  selectionHighlight: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  lightbulb: { enabled: 'off' as never },
  fixedOverflowWidgets: true,
  tabSize: 2
}
