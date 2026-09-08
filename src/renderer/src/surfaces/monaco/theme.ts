import type { ThemeRegistrationAny } from "shiki";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { shikiToMonaco, textmateThemeToMonacoTheme } from "@shikijs/monaco";
import { isLightScheme, SCHEME_CHANGE_EVENT } from "../../lib/appearance";
import { monaco } from "./monaco";
import { DARCULA, LIGHT, darcula, intellijLight } from "../../lib/intellijTheme";

export { darcula, intellijLight };

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

function themeRegistrations(): {
  light: ThemeRegistrationAny;
  dark: ThemeRegistrationAny;
  lightPalette: Record<string, string>;
  darkPalette: Record<string, string>;
} {
  const lightPalette = readPalette(false);
  const darkPalette = readPalette(true);
  return {
    lightPalette,
    darkPalette,
    light: {
      ...intellijLight,
      name: "mc-light",
      colors: { ...intellijLight.colors, ...lightPalette },
    },
    dark: {
      ...darcula,
      name: "mc-dark",
      colors: { ...darcula.colors, ...darkPalette },
    },
  };
}

/** (Re)define mc-light / mc-dark from the tokens as they are right now.
 *  Semantic-token styling rides the same theme trie as textmate tokens,
 *  so both themes carry the semantic rules appended. */
function defineThemes(): void {
  const { light, dark, lightPalette, darkPalette } = themeRegistrations();
  for (const [name, reg, isDark, palette] of [
    ["mc-light", light, false, lightPalette],
    ["mc-dark", dark, true, darkPalette],
  ] as const) {
    const t = textmateThemeToMonacoTheme(reg as never) as monaco.editor.IStandaloneThemeData;
    monaco.editor.defineTheme(name, {
      ...t,
      rules: [...t.rules, ...semanticRules(isDark, palette["editor.foreground"])],
    });
  }
}

/** Load grammars and register mc-light / mc-dark; idempotent. */
export function monacoReady(): Promise<void> {
  readyP ??= (async () => {
    const { light, dark } = themeRegistrations();
    // The JS regex engine: the CSP has no wasm, so oniguruma is out.
    const highlighter = await createHighlighter({
      themes: [light, dark],
      langs: EDITOR_LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    shikiToMonaco(highlighter, monaco);
    defineThemes();
    applyEditorTheme();
    // The bundled face may land after the first editor measured itself.
    void document.fonts.load("12px 'JetBrains Mono'").then(() => monaco.editor.remeasureFonts());
    // Workbench colours come from the app tokens: recompute on a scheme
    // flip and when the tint sliders rewrite the root's inline style.
    window.addEventListener(SCHEME_CHANGE_EVENT, recomputeEditorTheme);
    let tintTimer: number | null = null;
    new MutationObserver(() => {
      if (tintTimer !== null) window.clearTimeout(tintTimer);
      tintTimer = window.setTimeout(() => {
        tintTimer = null;
        recomputeEditorTheme();
      }, 80);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  })();
  return readyP;
}

/** Re-read the tokens, redefine both themes, and re-apply the current one. */
export function recomputeEditorTheme(): void {
  defineThemes();
  applyEditorTheme();
}

export function applyEditorTheme(): void {
  monaco.editor.setTheme(isLightScheme() ? "mc-light" : "mc-dark");
}
