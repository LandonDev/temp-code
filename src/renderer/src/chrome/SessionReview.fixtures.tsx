// Fixtures for `bun run ui:preview src/renderer/src/chrome/SessionReview.tsx#SessionReviewView`.
import type { CheckpointFile } from "../lib/checkpoint";

const cwd = "/Users/me/repo";
const file = (relative: string, additions: number, deletions: number): CheckpointFile => ({
  path: `${cwd}/${relative}`,
  relative,
  status: "M",
  additions,
  deletions,
});

const one = [file("src/renderer/src/chrome/SessionReview.tsx", 46, 12)];
const three = [
  file("src/renderer/src/chrome/SessionReview.tsx", 30, 9),
  file("src/renderer/src/chrome/SessionReview.fixtures.tsx", 12, 0),
  file("docs/LAYOUT.md", 4, 3),
];
const addsOnly = [file("src/lib/new.ts", 18, 0), file("src/lib/new.test.ts", 40, 0)];

const common = { busy: false, acting: null, onReview: "fn", onUndo: "fn", onKeep: "fn" };

export default [
  { name: "One file", props: { ...common, files: one } },
  { name: "Three files with adds and dels", props: { ...common, files: three } },
  { name: "Adds only", props: { ...common, files: addsOnly } },
  { name: "The thread works", props: { ...common, files: three, busy: true } },
  { name: "Undoing", props: { ...common, files: three, acting: "undo" } },
  { name: "Keeping", props: { ...common, files: one, acting: "keep" } },
];
