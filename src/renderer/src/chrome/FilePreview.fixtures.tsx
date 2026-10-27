const lines = [
  { number: 11, kind: "context", text: "// Opens the file the edit names." },
  { number: 12, kind: "context", text: "export function openEdit(path: string) {" },
  { number: 13, kind: "del", text: "  const view = Editor.open(path)" },
  { number: 13, kind: "add", text: "  const view = await Editor.open(path, { readOnly: false })" },
  { number: 14, kind: "add", text: "  if (!view) return null" },
  { number: 15, kind: "context", text: "  return view" },
];
const preview = { kind: "write", path: "/repo/src/renderer/src/lib/openEdit.ts", fileName: "openEdit.ts", additions: 2, deletions: 1, lines };
export default [
  { name: "pending, opens", props: { preview, status: "pending", cwd: "/repo", onOpenFile: "fn" } },
  { name: "rejected", props: { preview, status: "rejected", cwd: "/repo" } },
];
