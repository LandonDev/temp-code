// A7 (turn structure): ActionGroup's states for the static render harness.
import type { Block } from "../../lib/session";
import { setEditOpen } from "../editOpenState";

const CWD = "/Users/me/shop";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
const call = (id: string, name: string, kind: string, input: unknown, status = "completed"): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, kind, title: name, status, input },
});

/** A settled run: a read, a new file, a command, an edit and the tests. */
const run = (prefix: string): Block[] => [
  call(`${prefix}1`, "Read", "read", { file_path: `${CWD}/convex/types.ts` }),
  call(`${prefix}2`, "Write", "edit", { file_path: `${CWD}/convex/diag.ts`, content: lines(46) }),
  call(`${prefix}3`, "Bash", "execute", { command: "npx convex dev --once" }),
  call(`${prefix}4`, "Edit", "edit", { file_path: `${CWD}/convex/schema.ts`, old_string: "a", new_string: lines(3) }),
  call(`${prefix}5`, "Bash", "execute", { command: "npm test" }, prefix === "open" ? "completed" : "failed"),
];

// The harness renders with no session, so the opened state is keyed ":a:<first id>".
setEditOpen(":a:open1", true);

export const fixtures: { name: string; props: { blocks: Block[]; cwd: string; live?: boolean } }[] = [
  { name: "Settled run", props: { blocks: run("settled"), cwd: CWD } },
  { name: "Settled run, opened", props: { blocks: run("open"), cwd: CWD } },
  {
    name: "A thought, then a read",
    props: {
      blocks: [
        { id: "tr0", role: "reasoning", text: "The types first.", ts: 1, doneTs: 3001 },
        call("tr1", "Read", "read", { file_path: `${CWD}/convex/types.ts` }),
      ],
      cwd: CWD,
    },
  },
  { name: "Lone read", props: { blocks: [call("lone", "Read", "read", { file_path: `${CWD}/convex/types.ts` })], cwd: CWD } },
  {
    name: "Live run",
    props: {
      blocks: [
        call("live1", "Write", "edit", { file_path: `${CWD}/convex/diag.ts`, content: lines(12) }),
        call("live2", "Bash", "execute", { command: "npm test" }, "running"),
      ],
      cwd: CWD,
      live: true,
    },
  },
  {
    name: "Thought only",
    props: {
      blocks: [{ id: "think", role: "reasoning", text: "Weighing whether the index belongs on the table.", ts: 1, doneTs: 4001 }],
      cwd: CWD,
    },
  },
];
