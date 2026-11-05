// Fixtures for `bun run ui:preview src/renderer/src/surfaces/HunkBar.tsx#HunkBar`.
export default [
  { name: "a change against HEAD: revert and stage", props: { onRevert: "fn", onStage: "fn" } },
  { name: "a change against another branch: revert alone", props: { onRevert: "fn" } },
  { name: "busy", props: { onRevert: "fn", onStage: "fn", busy: true } },
];
