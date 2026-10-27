// Fixtures for `bun run ui:preview src/renderer/src/chrome/SurfaceTabs.tsx#SurfaceTabs`.
import type { FilePaneTab } from "../lib/layout";

const cwd = "/Users/me/repo";
const files: FilePaneTab[] = [
  { id: "a", path: `${cwd}/src/App.tsx`, cwd },
  { id: "b", path: `${cwd}/src/lib/session.ts`, cwd },
  { id: "c", path: `${cwd}/src/chrome/TitleBar.tsx`, cwd, review: true },
];

const common = {
  files,
  fileErrorCounts: new Map<string, number>(),
  onSelectFile: "fn",
  onCloseFile: "fn",
  onReorder: "fn",
};

export default [
  { name: "Three files: the first active, the second dirty, a review", props: { ...common, activeFileId: "a", dirtyFileIds: new Set(["b"]) } },
  { name: "The dirty file active", props: { ...common, activeFileId: "b", dirtyFileIds: new Set(["b"]) } },
];
