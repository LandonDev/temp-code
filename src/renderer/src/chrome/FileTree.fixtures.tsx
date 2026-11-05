// Fixtures for `bun run ui:preview src/renderer/src/chrome/FileTree.tsx#FileTree`: the Files
// section's 36px toolbar on the 12px inset. A static render has no host to list the folder,
// so the tree under it shows its failed-to-list line; the tree's own rows are FileTree.dom's.
export default [{ name: "the toolbar, over a folder the host did not list", props: { cwd: "/srv/agents/work/temp-code", onOpenFile: "fn" } }];
