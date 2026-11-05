// UI-16: the working line's phases for the static render harness
// (`bun run ui:preview src/renderer/src/surfaces/transcript/WorkingLine.tsx#TurnLine`).
import type { Block } from "../../lib/session";

const CWD = "/Users/me/shop";
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
    name: "A thought: its sentence in place of Thinking",
    props: live([user, { id: "r", role: "reasoning", text: "The schema has no index yet.", streaming: true }]),
  },
  {
    name: "A thought's second sentence",
    props: live([user, { id: "r", role: "reasoning", text: "The schema has no index yet. I should add one on the table.", streaming: true }]),
  },
  {
    name: "A long sentence, cut at the row's edge",
    props: live([
      user,
      {
        id: "r",
        role: "reasoning",
        text: "The table is read by every query in the inbox, the search and the board, so an index on its owner and its updated time would let each of them skip the full scan they do today.",
        streaming: true,
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
