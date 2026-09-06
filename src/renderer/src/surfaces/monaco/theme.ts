import type { ThemeRegistration, ThemeRegistrationAny } from "shiki";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import { isLightScheme, SCHEME_CHANGE_EVENT } from "../../lib/appearance";
import { monaco } from "./monaco";

/**
 * IntelliJ IDEA's editor palettes as TextMate themes (IntelliJ Light and
 * Darcula) for the syntax coat, with the workbench colors (backgrounds,
 * selection, widgets) read from MonoCode's own tokens. Themes are named
 * mc-light / mc-dark and follow the app scheme.
 */

interface Tone {
  fg: string;
  bg: string;
  comment: string;
  docComment: string;
  keyword: string;
  string: string;
  number: string;
  annotation: string;
  field: string;
  func: string;
  tag: string;
  attribute: string;
}

const DARCULA: Tone = {
  fg: "#A9B7C6",
  bg: "#2B2B2B",
  comment: "#808080",
  docComment: "#629755",
  keyword: "#CC7832",
  string: "#6A8759",
  number: "#6897BB",
  annotation: "#BBB529",
  field: "#9876AA",
  func: "#FFC66D",
  tag: "#E8BF6A",
  attribute: "#BABABA",
};

const LIGHT: Tone = {
  fg: "#080808",
  bg: "#FFFFFF",
  comment: "#8C8C8C",
  docComment: "#8C8C8C",
  keyword: "#0033B3",
  string: "#067D17",
  number: "#1750EB",
  annotation: "#9E880D",
  field: "#871094",
  func: "#00627A",
  tag: "#0033B3",
  attribute: "#174AD4",
};

function theme(name: string, type: "light" | "dark", t: Tone): ThemeRegistration {
  const rule = (scope: string | string[], foreground: string, fontStyle?: string) => ({
    scope,
    settings: { foreground, ...(fontStyle ? { fontStyle } : {}) },
  });
  return {
    name,
    type,
    colors: { "editor.background": t.bg, "editor.foreground": t.fg },
    tokenColors: [
      { settings: { foreground: t.fg, background: t.bg } },
      rule(["comment", "punctuation.definition.comment"], t.comment),
      rule(["comment.block.documentation", "comment.block.javadoc"], t.docComment, "italic"),
      rule(
        ["keyword.other.documentation", "storage.type.class.jsdoc", "variable.other.jsdoc"],
        t.docComment,
        "italic",
      ),
      rule(
        ["keyword", "storage", "constant.language", "variable.language", "constant.character.escape"],
        t.keyword,
      ),
      // IDEA leaves type names plain: undo the broad `storage` rule where the
      // java grammar uses it for types.
      rule(["storage.type.java", "storage.type.generic.java", "storage.type.object.array.java"], t.fg),
      rule(["string", "punctuation.definition.string", "constant.character"], t.string),
      rule("constant.character.escape", t.keyword),
      rule("constant.numeric", t.number),
      rule(
        [
          "storage.type.annotation",
          "punctuation.definition.annotation",
          "meta.declaration.annotation",
          "entity.name.function.decorator",
          "punctuation.decorator",
          "meta.decorator",
        ],
        t.annotation,
      ),
      rule(
        [
          "variable.other.property",
          "variable.other.object.property",
          "variable.other.member",
          "variable.other.constant",
          "support.type.property-name",
        ],
        t.field,
      ),
      rule(["entity.name.function", "support.function"], t.func),
      rule("entity.name.tag", t.tag),
      rule("entity.other.attribute-name", t.attribute),
      rule("markup.heading", t.keyword),
      rule("markup.inserted", t.string),
      rule("markup.deleted", type === "dark" ? "#CF5B56" : "#C22D2D"),
      { scope: "markup.italic", settings: { fontStyle: "italic" } },
      { scope: "markup.bold", settings: { fontStyle: "bold" } },
    ],
  };
}

export const darcula = theme("darcula", "dark", DARCULA);
export const intellijLight = theme("intellij-light", "light", LIGHT);

/**
 * Semantic-token theme rules (token = `type.modifier…`). Modifier order in
 * the key follows each server's legend bit order, jdtls puts `static` before
 * `declaration`, vtsls the reverse, so both orders appear.
 */
export function semanticRules(
  dark: boolean,
  fg: string,
): { token: string; foreground?: string; fontStyle?: string }[] {
  const t = dark ? DARCULA : LIGHT;
  return [
    { token: "property", foreground: t.field },
    { token: "property.static", fontStyle: "italic" },
    { token: "property.declaration.static", fontStyle: "italic" },
    { token: "enumMember", foreground: t.field, fontStyle: "italic" },
    { token: "recordComponent", foreground: t.field },
    { token: "method", foreground: fg },
    { token: "method.static", foreground: fg, fontStyle: "italic" },
    { token: "method.declaration", foreground: t.func },
    { token: "method.static.declaration", foreground: t.func, fontStyle: "italic" },
    { token: "method.declaration.static", foreground: t.func, fontStyle: "italic" },
    { token: "method.abstract.declaration", foreground: t.func },
    { token: "function", foreground: fg },
    { token: "function.declaration", foreground: t.func },
    { token: "decorator", foreground: t.annotation },
    { token: "annotationMember", foreground: t.annotation },
    { token: "modifier", foreground: t.keyword },
    { token: "variable.readonly", foreground: t.field, fontStyle: "italic" },
    { token: "variable.declaration.readonly", foreground: t.field, fontStyle: "italic" },
  ];
}

// ── workbench colors from tokens ─────────────────────────────────────

let colorProbe: CanvasRenderingContext2D | null = null;

/** Resolve any CSS color (hsl chains, color-mix, var) to #rrggbb[aa]. */
export function cssToHex(css: string): string | undefined {
  if (!css.trim()) return undefined;
  colorProbe ??= document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (!colorProbe) return undefined;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = css.trim();
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a < 255 ? hex(a) : ""}`;
}

/** Read one scheme's palette. Toggles `theme-light` on <html> synchronously
 *  while reading; no frame renders in between, so nothing flashes. */
export function readPalette(dark: boolean): Record<string, string> {
  const html = document.documentElement;
  const had = html.classList.contains("theme-light");
  html.classList.toggle("theme-light", !dark);
  const cs = getComputedStyle(html);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const solid = (name: string, fallback: string) => {
    const hex = cssToHex(v(name)) ?? fallback;
    return hex.slice(0, 7);
  };
  const base = solid("--color-background-base", dark ? "#171717" : "#f7f7f7");
  const content = solid("--color-content", dark ? "#ebebeb" : "#2e2e2e");
  const accent = solid("--color-accent", "#4c9aff");
  const withAlpha = (hex: string, alpha: number) =>
    hex.slice(0, 7) + Math.round(alpha * 255).toString(16).padStart(2, "0");
  // Content over base at the alphas editorChrome.ts uses for the CodeMirror pane.
  const mix = (pct: number) =>
    cssToHex(`color-mix(in srgb, ${content} ${pct}%, ${base})`)?.slice(0, 7) ?? content;
  const faint = mix(38);
  const muted = mix(60);
  const hairline = mix(7);
  const borderStrong = mix(16);
  const popover = mix(4);
  const success = solid("--color-success", "#34d399");
  const warning = solid("--color-warning", "#fbbf24");
  const danger = solid("--color-danger", "#f87171");
  const info = solid("--color-info", "#60a5fa");

  const palette: Record<string, string> = {
    "editor.background": base,
    "editor.foreground": content,
    "editorGutter.background": base,
    "editorLineNumber.foreground": faint,
    "editorLineNumber.activeForeground": muted,
    "editor.lineHighlightBackground": mix(4),
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": withAlpha(accent, 0.22),
    "editor.inactiveSelectionBackground": withAlpha(accent, 0.12),
    "editorCursor.foreground": content,
    "editorWhitespace.foreground": hairline,
    "editorIndentGuide.background1": dark ? "#2E3136" : "#E8EAED",
    "editorIndentGuide.activeBackground1": dark ? "#4C5058" : "#C9CCD3",
    "editorBracketMatch.background": "#00000000",
    "editorBracketMatch.border": borderStrong,
    "editorWidget.background": popover,
    "editorWidget.foreground": content,
    "editorWidget.border": borderStrong,
    // IDEA new-UI popup surfaces.
    "editorSuggestWidget.background": dark ? "#2B2D30" : "#F7F8FA",
    "editorSuggestWidget.border": dark ? "#1E1F22" : "#C9CCD6",
    "editorSuggestWidget.foreground": dark ? "#BCBEC4" : "#000000",
    "editorSuggestWidget.selectedBackground": dark ? "#393B40" : "#D5E1FF",
    "editorSuggestWidget.selectedForeground": dark ? "#FFFFFF" : "#080808",
    "editorSuggestWidget.selectedIconForeground": dark ? "#FFFFFF" : "#080808",
    "editorSuggestWidget.focusHighlightForeground": dark ? "#FFFFFF" : "#000000",
    "editorSuggestWidget.highlightForeground": dark ? "#FFFFFF" : "#000000",
    "editorHoverWidget.background": popover,
    "editorHoverWidget.border": borderStrong,
    "input.background": mix(5),
    "input.border": borderStrong,
    "inputOption.activeBorder": accent,
    "list.hoverBackground": mix(6),
    "list.activeSelectionBackground": mix(10),
    "list.activeSelectionForeground": content,
    "scrollbarSlider.background": withAlpha(content, 0.08),
    "scrollbarSlider.hoverBackground": withAlpha(content, 0.16),
    "scrollbarSlider.activeBackground": withAlpha(content, 0.2),
    "editorError.foreground": danger,
    "editorWarning.foreground": warning,
    "editorInfo.foreground": info,
    "editorGhostText.foreground": faint,
    "editorInlayHint.foreground": muted,
    "editorInlayHint.background": withAlpha(content, 0.06),
    "diffEditor.insertedTextBackground": withAlpha(success, 0.14),
    "diffEditor.removedTextBackground": withAlpha(danger, 0.14),
    "diffEditor.insertedLineBackground": withAlpha(success, 0.07),
    "diffEditor.removedLineBackground": withAlpha(danger, 0.07),
    "diffEditorGutter.insertedLineBackground": withAlpha(success, 0.07),
    "diffEditorGutter.removedLineBackground": withAlpha(danger, 0.07),
    "peekView.border": borderStrong,
    "peekViewEditor.background": base,
    "peekViewResult.background": popover,
    "peekViewTitle.background": popover,
  };
  // No rainbow brackets (IDEA has none): pin all six to plain fg.
  for (let i = 1; i <= 6; i++) {
    palette[`editorBracketHighlight.foreground${i}`] = content;
  }
  html.classList.toggle("theme-light", had);
  return palette;
}

const EDITOR_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "scss",
  "html",
  "java",
  "kotlin",
  "groovy",
  "xml",
  "yaml",
  "markdown",
  "ini",
  "sql",
  "shellscript",
  "python",
  "diff",
];

let readyP: Promise<void> | null = null;

/** Load grammars and register mc-light / mc-dark; idempotent. */
export function monacoReady(): Promise<void> {
  readyP ??= (async () => {
    const lightPalette = readPalette(false);
    const darkPalette = readPalette(true);
    const mcLight: ThemeRegistrationAny = {
      ...intellijLight,
      name: "mc-light",
      colors: { ...intellijLight.colors, ...lightPalette },
    };
    const mcDark: ThemeRegistrationAny = {
      ...darcula,
      name: "mc-dark",
      colors: { ...darcula.colors, ...darkPalette },
    };
    // The JS regex engine: the CSP has no wasm, so oniguruma is out.
    const highlighter = await createHighlighter({
      themes: [mcLight, mcDark],
      langs: EDITOR_LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    shikiToMonaco(highlighter, monaco);
    // Semantic-token styling rides the same theme trie as textmate tokens:
    // re-define both themes with the semantic rules appended.
    for (const [name, reg, dark, palette] of [
      ["mc-light", mcLight, false, lightPalette],
      ["mc-dark", mcDark, true, darkPalette],
    ] as const) {
      const t = textmateThemeToMonacoTheme(reg as never) as monaco.editor.IStandaloneThemeData;
      monaco.editor.defineTheme(name, {
        ...t,
        rules: [...t.rules, ...semanticRules(dark, palette["editor.foreground"])],
      });
    }
    applyEditorTheme();
    window.addEventListener(SCHEME_CHANGE_EVENT, applyEditorTheme);
  })();
  return readyP;
}

export function applyEditorTheme(): void {
  monaco.editor.setTheme(isLightScheme() ? "mc-light" : "mc-dark");
}
