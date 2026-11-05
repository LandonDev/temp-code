import type { ThreadState } from "./status";

/** StatusMark for `bun run ui:preview`: every state with its word alone, with
 *  the detail a row would give it, and still (working's dot). */
const DETAIL: Record<ThreadState, string> = {
  working: "Editing Rail.tsx",
  waiting: "Approve Bash",
  paused: "By you",
  failed: "Usage cap",
  queued: "Waiting for memory",
  stopped: "The harness is gone",
  watching: "3 subagents",
  "plan-ready": "7 tasks",
  done: "Landed 12:08 PM",
  idle: "3/7",
};

const STATES = Object.keys(DETAIL) as ThreadState[];

export default [
  ...STATES.map((state) => ({ name: `${state}, word alone`, props: { state } })),
  ...STATES.map((state) => ({ name: `${state}, with its detail`, props: { state, detail: DETAIL[state] } })),
  { name: "working, still, with its detail", props: { state: "working", still: true, detail: "Reading format.ts" } },
];
