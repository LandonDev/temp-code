import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
// register.all only wires the *viewport* (range) semantic-tokens contrib;
// the full-document feature must be imported explicitly — without it
// semantic highlighting silently never runs (jdtls serves full only).
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens'
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
import { createHighlighter, type ThemeRegistrationAny } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { shikiToMonaco, textmateThemeToMonacoTheme } from '@shikijs/monaco'
import { darcula, intellijLight, semanticRules } from './themes/intellij'

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
    // IDEA new-UI popup, exact surfaces (user screenshots 2026-08-16):
    // panel #2B2D30, hairline border, muted #393B40 selection bar.
    'editorSuggestWidget.background': dark ? '#2B2D30' : '#F7F8FA',
    'editorSuggestWidget.border': dark ? '#1E1F22' : '#C9CCD6',
    'editorSuggestWidget.foreground': dark ? '#BCBEC4' : '#000000',
    'editorSuggestWidget.selectedBackground': dark ? '#393B40' : '#D5E1FF',
    'editorSuggestWidget.selectedForeground': dark ? '#FFFFFF' : '#080808',
    'editorSuggestWidget.selectedIconForeground': dark ? '#FFFFFF' : '#080808',
    'editorSuggestWidget.focusHighlightForeground': dark ? '#FFFFFF' : '#000000',
    'editorSuggestWidget.highlightForeground': dark ? '#FFFFFF' : '#000000',
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
    'editorInlayHint.foreground': cssToHex(v('--muted-foreground'))!,
    'editorInlayHint.background': withAlpha('--foreground', 0.06),
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
  // No rainbow brackets (IDEA doesn't): monaco falls back to gold/orchid
  // defaults wherever colorization sneaks on, so pin all six to plain fg.
  for (let i = 1; i <= 6; i++) {
    palette[`editorBracketHighlight.foreground${i}`] = palette['editor.foreground']
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
    // IntelliJ syntax colors on the app's own workbench colors (backgrounds,
    // selection, widgets) — readPalette wins over the theme's colors.
    const lightPalette = readPalette(false)
    const darkPalette = readPalette(true)
    const tcLight: ThemeRegistrationAny = {
      ...intellijLight,
      name: 'tc-light',
      colors: { ...intellijLight.colors, ...lightPalette }
    }
    const tcDark: ThemeRegistrationAny = {
      ...darcula,
      name: 'tc-dark',
      colors: { ...darcula.colors, ...darkPalette }
    }
    // The JS regex engine: no WASM, so the renderer CSP stays wasm-free
    // (oniguruma's WebAssembly.instantiate is blocked by script-src 'self').
    const highlighter = await createHighlighter({
      themes: [tcLight, tcDark],
      langs: EDITOR_LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true })
    })
    shikiToMonaco(highlighter, monaco)
    // Semantic-token styling rides the same theme trie as textmate tokens:
    // re-define both themes with the semantic rules appended (safe — the
    // shiki tokenizer keeps its own copy of the base rules).
    for (const [name, reg, dark, palette] of [
      ['tc-light', tcLight, false, lightPalette],
      ['tc-dark', tcDark, true, darkPalette]
    ] as const) {
      // shiki types this against monaco-editor-core (not installed) — the
      // shape is IStandaloneThemeData.
      const t = textmateThemeToMonacoTheme(reg as never) as monaco.editor.IStandaloneThemeData
      monaco.editor.defineTheme(name, {
        ...t,
        rules: [...t.rules, ...semanticRules(dark, palette['editor.foreground'])]
      })
    }
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
  // IDEA's own face and sizing: JetBrains Mono 13, roomy leading, no
  // ligatures (the IDEA default).
  fontFamily: "'JetBrains Mono', 'Geist Mono', ui-monospace, Menlo, monospace",
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  'semanticHighlighting.enabled': true,
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
  // IDEA completion feel: remember the last pick, prefer nearby symbols,
  // no plain-word fallback entries, and keep completing inside snippet
  // placeholders (the option's declared default is false but an upstream
  // validation bug makes it true unless set explicitly).
  suggestSelection: 'recentlyUsed',
  // IDEA overtypes any matching closer: typing ) in front of a ) that a
  // snippet or auto-close inserted skips it instead of doubling it.
  autoClosingOvertype: 'always',
  wordBasedSuggestions: 'off',
  suggest: { localityBonus: true, snippetsPreventQuickSuggestions: false, showStatusBar: true },
  suggestLineHeight: 26,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  lightbulb: { enabled: 'onCode' as never },
  fixedOverflowWidgets: true,
  tabSize: 2
}
