const diff = { additions: 42, deletions: 7, index: 1, total: 5, onPrev: "fn", onNext: "fn" };
export default [
  { name: "review tab", props: { folder: "src/renderer/src/surfaces", diff, save: { status: "idle" } } },
  { name: "review tab against HEAD: revert and stage", props: { folder: "src/renderer/src/surfaces", diff: { ...diff, onRevert: "fn", onStage: "fn" }, save: { status: "idle" } } },
  { name: "review tab, caret above the first change", props: { folder: "src/renderer/src/surfaces", diff: { ...diff, index: -1, onRevert: "fn", onStage: "fn" }, save: { status: "idle" } } },
  { name: "review tab on a Markdown file, saving", props: { folder: "docs", diff, markdown: { mode: "preview", onModeChange: "fn" }, save: { status: "saving" } } },
  { name: "deep folder, save failed", props: { folder: "src/main/server/remote/very/deep/folder/that/does/not/fit/in/the/header/at/all", save: { status: "error", message: "EACCES" } } },
  { name: "project root, no changes", props: { folder: null, diff: { ...diff, additions: 0, deletions: 0, index: 0, total: 0 }, save: { status: "idle" } } },
];
