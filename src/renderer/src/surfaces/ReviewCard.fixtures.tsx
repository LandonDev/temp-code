// A merge review's outcomes for `bun run ui:preview src/renderer/src/surfaces/ReviewCard.tsx#ReviewCard`.
import type { ReviewFinding } from "@server/shared/review";
import type { Block } from "../lib/session";

const finding = (file: string, line: number, summary: string, failure_scenario = ""): ReviewFinding => ({ file, line, summary, failure_scenario });
const review = (over: Partial<NonNullable<Block["review"]>>): { block: Block; cwd: string } => ({
  cwd: "/repo",
  block: {
    id: "r",
    role: "system",
    text: "",
    review: {
      runId: "run1",
      reviewerId: "rev1",
      provider: "codex",
      model: "gpt-6.1-sol",
      outcome: "pass",
      branch: "port-the-view",
      target: "master",
      blocking: [],
      minor: [],
      merged: true,
      pushed: true,
      ...over,
    },
  },
});

const blocking = [
  finding("src/renderer/src/surfaces/GateCard.tsx", 31, "The log keeps its card inside a table", "An open group's red gate draws a bordered card inside the table"),
  finding("src/main/server/mergeReview.ts", 212, "A failed push retries with a new reviewer", "A head that passed is reviewed twice after a flaky push"),
];
const minor = [finding("docs/TRANSCRIPT.md", 129, "Names the old fixture file"), finding("src/renderer/src/lib/cn.ts", 4, "A comment says the wrong merge order")];

export const fixtures: { name: string; props: { block: Block; cwd: string } }[] = [
  { name: "Passed, no findings", props: review({}) },
  { name: "Passed, two minor (behind the caret)", props: review({ minor }) },
  { name: "Timed out, merged without it", props: review({ outcome: "timeout", minutes: 15 }) },
  { name: "Failed to run, merged without it", props: review({ outcome: "failed", reason: "the reviewer ended without reporting" }) },
  { name: "Merged anyway", props: review({ outcome: "merged-anyway", blocking }) },
  { name: "Held: the one card, Merge anyway", props: review({ outcome: "held", merged: false, pushed: false, blocking, minor }) },
];
