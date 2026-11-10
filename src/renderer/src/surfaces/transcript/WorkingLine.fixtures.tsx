// UI-16: the working line's phases for the static render harness
// (`bun run ui:preview src/renderer/src/surfaces/transcript/WorkingLine.tsx#TurnLine`).
import type { Block } from "../../lib/session";

const CWD = "/Users/me/shop";
/** The thought's start: four seconds before the harness renders. */
const STARTED = Date.now() - 4_000;
const user: Block = { id: "u", role: "user", text: "Add the index" };
const call = (id: string, name: string, kind: string, input: unknown, status = "running"): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, kind, title: name, status, input },
});
const live = (turn: Block[], activity?: string) => ({ live: true, turn, activity, cwd: CWD, closing: null });

export default [
  { name: "Sending", props: live([{ ...user, pending: true }]) },
  { name: "The host's wait", props: live([user], "Waiting for the provider, 25 s") },
  { name: "Thinking, before its first words", props: live([user, { id: "r", role: "reasoning", text: "", streaming: true }]) },
  {
    name: "A thought: Thinking with its seconds, its first sentence in the column",
    props: live([user, { id: "r", role: "reasoning", text: "The schema has no index yet. I should", streaming: true, startedAt: STARTED }]),
  },
  {
    name: "A thought past a minute, several sentences",
    props: live([
      user,
      {
        id: "r",
        role: "reasoning",
        text: "The schema has no index yet. I should add one on the table.\n\nThe table is read by every query in the inbox, the search and the board, so an index on its owner and its updated time would let each of them skip the full scan they do today. Still weighing the",
        streaming: true,
        startedAt: STARTED - 68_000,
      },
    ]),
  },
  {
    name: "A long thought: the column at its cap, scrolled to its newest line",
    props: live([
      user,
      {
        id: "r",
        role: "reasoning",
        text: [
          "The inbox query filters by owner and sorts by updated time, so a full scan runs on every open.",
          "An index on owner and updated time would let Convex seek straight to the owner's rows.",
          "The search and the board read the same table, so the one index serves all three.\n\nThe schema has no index on the table yet, and the migration is only the schema change: Convex builds the index on deploy.",
          "I should check whether any query orders by created time instead, which the index would not cover.",
          "Then the tests: the inbox test seeds twenty rows and asserts the order, so it will catch a wrong index field.",
        ].join(" "),
        streaming: true,
        startedAt: STARTED - 23_000,
      },
    ]),
  },
  { name: "One call", props: live([user, call("c1", "Read", "read", { file_path: `${CWD}/convex/format.ts` })]) },
  {
    name: "Several calls",
    props: live([
      user,
      call("c1", "Read", "read", { file_path: `${CWD}/convex/a.ts` }),
      call("c2", "Read", "read", { file_path: `${CWD}/convex/b.ts` }),
      call("c3", "Read", "read", { file_path: `${CWD}/convex/c.ts` }),
    ]),
  },
  {
    name: "One edit, with its counts",
    props: live([user, call("e1", "Edit", "edit", { file_path: `${CWD}/convex/schema.ts`, old_string: "a", new_string: "a\nb\nc\nd" })]),
  },
  { name: "One command, which opens", props: live([user, call("b1", "Bash", "execute", { command: "bun test convex" })]) },
  {
    name: "The wait on a subagent",
    props: { ...live([user]), waitOn: "Review the perf pass" },
  },
  { name: "Writing (the mark alone)", props: live([user, { id: "p", role: "assistant", text: "Here is the index", streaming: true }]) },
  {
    name: "Settled: the closing line",
    props: { live: false, turn: [user], cwd: CWD, closing: { words: <span>Worked for 2m 4s</span>, actions: null } },
  },
];
