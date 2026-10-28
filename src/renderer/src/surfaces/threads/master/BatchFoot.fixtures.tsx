// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/master/BatchFoot.tsx#BatchFoot`.
import { emptyBatch, type BatchState, type BatchStep } from "@server/shared/contract-batch";

const t = Date.now() - 5 * 60_000;
const noop = async () => {};
const missing = 'error: Module not found "scripts/gate.ts"';

/** The default steps (land, gate, release) with these states. */
function batch(gate: Partial<BatchStep>, release: Partial<BatchStep> = {}): BatchState {
  const state = emptyBatch("m");
  const [land, g, r] = state.steps;
  return {
    ...state,
    steps: [
      { ...land, status: "passed", detail: "nothing landed", at: t, startedAt: t, endedAt: t },
      { ...g, at: t, startedAt: t, endedAt: t + 69_000, ...gate },
      { ...r, ...release },
    ],
  };
}

const props = (state: BatchState) => ({ batch: state, titleOf: () => undefined, onSave: noop, onStop: noop });

export default [
  {
    // A script that never ran: its one line is the row's, with no console under it.
    name: "gate script missing",
    props: props(batch({ status: "failed", detail: missing, endedAt: t, log: [missing] })),
  },
  {
    name: "vitest failed",
    props: props(
      batch({
        status: "failed",
        detail: "vitest: src/total.test.ts > rounds the total",
        log: [
          "  ✓ typecheck  21.0s  passed",
          "  ✗ vitest       48s  failed  exit 1",
          "--- vitest (last lines) ---",
          " FAIL  src/total.test.ts > rounds the total",
          "AssertionError: expected 3 to be 4",
          "--- end vitest ---",
          "gate failed: vitest in 1m 9s",
        ],
      }),
    ),
  },
  {
    // The time column says each step's time; the details say no more than the glyphs.
    name: "passed",
    props: props(
      batch(
        { status: "passed", detail: "passed in 1m 09s", log: ["gate passed in 1m 9s"] },
        { status: "passed", detail: "release-278 tagged", at: t, startedAt: t + 69_000, endedAt: t + 77_000 },
      ),
    ),
  },
];
