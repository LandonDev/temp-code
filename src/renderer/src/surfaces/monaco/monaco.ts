import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
// register.all only wires the viewport (range) semantic-tokens contrib; the
// full-document feature must be imported explicitly or semantic highlighting
// silently never runs (jdtls serves full only).
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/kotlin/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/python/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * All Monaco wiring in one module: the worker environment, language
 * registration, and the shared editor options. Only ever imported lazily
 * from inside the Monaco pane chunk, never on app start. The root
 * `monaco-editor` entry is never imported: it ships the TS/JSON/CSS
 * language services, which would double every LSP diagnostic.
 */

export { monaco };

// The base editor worker is the only worker we ship: language smarts come
// from the LSP pool, tokenization from shiki on the main thread.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const BRACKET_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "`", close: "`", notIn: ["string", "comment"] },
  ],
};

// tsx/jsx get their own ids so shiki's dedicated grammars paint them and the
// LSP client can map them to typescriptreact/javascriptreact. json has no
// Monarch definition in 0.56 (its coloring lived in the json service).
for (const [id, exts] of [
  ["tsx", [".tsx"]],
  ["jsx", [".jsx"]],
  ["groovy", [".gradle", ".groovy"]],
  ["json", [".json", ".jsonc"]],
] as const) {
  monaco.languages.register({ id, extensions: [...exts] });
  monaco.languages.setLanguageConfiguration(id, BRACKET_CONFIG);
}
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/\b(true|false|null)\b/, "keyword"],
      [/\/\/.*$/, "comment"],
      [/[{}[\],:]/, "delimiter"],
    ],
  },
});

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".gradle": "groovy",
  ".groovy": "groovy",
  ".xml": "xml",
  ".pom": "xml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".md": "markdown",
  ".properties": "ini",
  ".ini": "ini",
  ".toml": "ini",
  ".sql": "sql",
  ".sh": "shell",
  ".zsh": "shell",
  ".bash": "shell",
  ".py": "python",
};

/** Monaco language id for a path; models are created with this. */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

/** JVM sources indent by four, everything else by two (editorTyping's rule). */
export function tabSizeForPath(path: string): number {
  const lang = languageForPath(path);
  return lang === "java" || lang === "kotlin" || lang === "groovy" || lang === "python"
    ? 4
    : 2;
}

/** The app's mono stack, resolved: Monaco measures glyphs and needs a real list. */
export function editorFontFamily(): string {
  const fromToken = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return `'JetBrains Mono', ${fromToken || "ui-monospace, Menlo, monospace"}`;
}

/** Shared editor options: quiet chrome, the buffer is the hero. */
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  "semanticHighlighting.enabled": true,
  codeLensFontSize: 11,
  minimap: { enabled: false },
  glyphMargin: false,
  folding: true,
  showFoldingControls: "mouseover",
  renderLineHighlight: "line",
  renderLineHighlightOnlyWhenFocus: true,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: "smooth",
  automaticLayout: true,
  padding: { top: 8, bottom: 32 },
  stickyScroll: { enabled: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  guides: { indentation: true, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  occurrencesHighlight: "singleFile",
  selectionHighlight: true,
  // IDEA completion feel: remember the last pick, prefer nearby symbols,
  // no plain-word fallback entries, keep completing inside placeholders.
  suggestSelection: "recentlyUsed",
  autoClosingOvertype: "always",
  wordBasedSuggestions: "off",
  suggest: {
    localityBonus: true,
    snippetsPreventQuickSuggestions: false,
    showStatusBar: true,
  },
  suggestLineHeight: 26,
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
  lightbulb: { enabled: "onCode" as never },
  fixedOverflowWidgets: true,
  tabSize: 2,
};
