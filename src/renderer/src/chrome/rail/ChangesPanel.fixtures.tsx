// Fixtures for `bun run ui:preview src/renderer/src/chrome/rail/ChangesPanel.tsx#ChangesView`.
import type { GitDiffIndex } from "../../lib/fs";
import { changesRules, type ChangesActions } from "./ChangesPanel";

const noop = () => {};
const actions: ChangesActions = {
  open: noop,
  openInEditor: noop,
  stage: noop,
  unstage: noop,
  discard: noop,
  toggleHunks: noop,
  stageHunk: noop,
  stageAll: noop,
  unstageAll: noop,
  pull: noop,
  push: noop,
  stash: noop,
  sync: noop,
  createPr: noop,
  viewPr: noop,
  generate: noop,
  commit: noop,
};

const f = (relative: string, over: Partial<GitDiffIndex["files"][number]> = {}) => ({
  path: `/p/${relative}`,
  relative,
  status: "modified",
  additions: 12,
  deletions: 3,
  staged: false,
  unstaged: true,
  ...over,
});

const index = (over: Partial<GitDiffIndex> = {}): GitDiffIndex => ({
  branch: "a5-right-panel-sections",
  files: [],
  additions: 0,
  deletions: 0,
  remote: "origin",
  upstream: "origin/a5-right-panel-sections",
  defaultBranch: "master",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  ...over,
});

const base = (ix: GitDiffIndex | null, message = "", over: Record<string, unknown> = {}) => ({
  index: ix,
  pr: null,
  rules: changesRules(ix, null, message, false),
  selectedPath: undefined,
  busy: null,
  error: null,
  message,
  onMessage: noop,
  folds: {},
  editorLabel: () => "Open in VS Code",
  actions,
  ...over,
});

const unstaged = index({
  files: [
    f("src/renderer/src/chrome/rail/ChangesPanel.tsx"),
    f("src/renderer/src/surfaces/editorGit.ts", { additions: 18, deletions: 0 }),
    f("docs/LAYOUT.md", { status: "untracked" }),
  ],
});

const mixed = index({
  files: [
    f("src/renderer/src/chrome/rail/ChangesPanel.tsx", { staged: true, unstaged: false }),
    f("src/renderer/src/chrome/rail/BranchPanel.tsx", { status: "deleted", staged: true, unstaged: false, additions: 0, deletions: 409 }),
    f("src/renderer/src/surfaces/RightPanel.tsx", { additions: 4, deletions: 9 }),
    f("src/renderer/src/lib/rightPanel.ts", { additions: 1, deletions: 3 }),
  ],
});

export default [
  { name: "loading", props: base(null) },
  { name: "empty", props: base(index()) },
  { name: "unstaged only", props: base(unstaged) },
  {
    name: "staged and unstaged, a hunk fold open, one selected",
    props: base(mixed, "Fold Branch into Changes", {
      selectedPath: "src/renderer/src/lib/rightPanel.ts",
      folds: {
        "src/renderer/src/surfaces/RightPanel.tsx": {
          hunks: [
            { from: 12, to: 14, additions: 2, deletions: 4, pos: 0 },
            { from: 198, to: 212, additions: 2, deletions: 5, pos: 0 },
          ],
        },
      },
    }),
  },
  {
    name: "ahead and behind, with a pull request",
    props: base(index({ ahead: 2, behind: 1 }), "", {
      pr: { number: 42, title: "A5", url: "https://github.com/o/r/pull/42", state: "open" },
      rules: { ...changesRules(index({ ahead: 2, behind: 1 }), null, "", false), canViewPr: true },
    }),
  },
  { name: "ready for a pull request", props: base(index({ aheadOfDefault: 3 })) },
  { name: "not published", props: base(index({ upstream: null })) },
  { name: "error", props: base(unstaged, "", { error: "fatal: Unable to create '.git/index.lock': File exists." }) },
];
