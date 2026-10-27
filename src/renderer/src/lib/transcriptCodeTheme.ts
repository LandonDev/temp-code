import type { ThemeRegistration } from "shiki";

/**
 * The transcript's code colouring: neutral, told apart by weight, never by
 * hue. Green means lines added and amber means the person is needed
 * everywhere else in the app, so code never borrows them. Every colour is
 * a CSS variable the markdown defines from the ink tokens
 * (transcript/markdown.css: `--code-strong` is the foreground, `--code-soft`
 * the muted foreground), so one theme serves dark and light. The Monaco
 * editor keeps intellijTheme.ts. No DOM imports: the worker loads this.
 */

const STRONG = "var(--code-strong)";
const SOFT = "var(--code-soft)";

export const TRANSCRIPT_CODE_THEME_NAME = "transcript-neutral";

export const transcriptCodeTheme: ThemeRegistration = {
  name: TRANSCRIPT_CODE_THEME_NAME,
  type: "dark",
  colors: {
    "editor.foreground": STRONG,
    "editor.background": "transparent",
  },
  fg: STRONG,
  bg: "transparent",
  settings: [
    { settings: { foreground: STRONG } },
    {
      scope: ["keyword", "storage", "keyword.control", "storage.type", "storage.modifier"],
      settings: { foreground: STRONG, fontStyle: "bold" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "entity.name.type",
        "support.type",
        "support.class",
        "entity.name",
        "variable",
        "constant.numeric",
        "constant",
        "entity.name.tag",
        "entity.other.attribute-name",
      ],
      settings: { foreground: STRONG },
    },
    { scope: ["string", "string.template"], settings: { foreground: SOFT } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: SOFT, fontStyle: "italic" } },
    { scope: ["punctuation", "keyword.operator", "meta.brace"], settings: { foreground: SOFT } },
  ],
};
