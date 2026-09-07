/**
 * Which editor opens a path. Monaco is the editor for text: every file it
 * can hold as a model goes there, whatever the language. CodeMirror keeps
 * only what Monaco has no surface for: Markdown, whose CodeMirror pane
 * carries the rendered preview.
 */

const CODEMIRROR_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

export type EditorKind = "monaco" | "codemirror";

export function editorForPath(path: string): EditorKind {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return CODEMIRROR_EXTENSIONS.has(ext) ? "codemirror" : "monaco";
}
