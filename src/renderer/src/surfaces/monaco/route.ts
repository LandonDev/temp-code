/** Extensions Monaco renders; everything else stays in CodeMirror. */
export const MONACO_EXTENSIONS = [
  ".java",
  ".kt",
  ".kts",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

export type EditorKind = "monaco" | "codemirror";

export function editorForPath(path: string): EditorKind {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "codemirror";
  const ext = name.slice(dot);
  return (MONACO_EXTENSIONS as readonly string[]).includes(ext) ? "monaco" : "codemirror";
}
