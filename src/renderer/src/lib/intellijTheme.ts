import type { ThemeRegistration } from "shiki";

/**
 * IntelliJ IDEA's editor palettes as TextMate themes (IntelliJ Light and
 * Darcula). One palette for the whole app: the Monaco editor overlays its
 * workbench colors on top (monaco/theme.ts), and the transcript's highlight
 * worker paints code blocks with these as-is on a transparent block. This
 * file must stay free of DOM and Monaco imports so the worker can load it.
 */

export interface Tone {
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

export const DARCULA: Tone = {
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

export const LIGHT: Tone = {
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
