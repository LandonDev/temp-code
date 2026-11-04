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

/** A master's stretch: it spawns a child, waits, hears back, and the gate runs. */
const orchestration = (prefix: string): Block[] => [
  {
    ...call(`${prefix}1`, "mcp__orchestrator__spawn_agent", "other", { task: "Port the view to the new board" }),
    tool: {
      callId: `${prefix}1`,
      name: "mcp__orchestrator__spawn_agent",
      kind: "other",
      status: "completed",
      input: { task: "Port the view to the new board" },
      spawned: [`${prefix}-child`],
    },
  },
  call(`${prefix}2`, "mcp__orchestrator__wait_for_agent", "other", { agentId: `${prefix}-child` }),
  { id: `${prefix}3`, role: "system", text: "", agent: { id: `${prefix}-child`, title: "Port the view", status: "done" } },
  {
    id: `${prefix}4`,
    role: "system",
    text: "",
    gate: { step: "gate", branch: "port-the-view", ok: false, log: "› typecheck\n✓ typecheck 21s\n› vitest\n✗ vitest 48s\ngate failed: vitest", at: 0 },
  },
];

/** A wake: two children reported, a background task finished, then the calls it led to. */
const wake = (prefix: string): Block[] => [
  { id: `${prefix}1`, role: "system", text: "", agent: { id: `${prefix}-a`, title: "Port the view", status: "done" } },
  { id: `${prefix}2`, role: "system", text: "", agent: { id: `${prefix}-b`, title: "Fix the fold", status: "error" } },
  { id: `${prefix}3`, role: "system", text: "deploy the preview", task: { id: "t1", label: "deploy the preview", status: "completed" } },
  call(`${prefix}4`, "Bash", "execute", { command: "git log --oneline -5" }),
  call(`${prefix}5`, "Read", "read", { file_path: `${CWD}/convex/schema.ts` }),
];

/** One of every row kind, for the table: each row on the step grid (stepLine.ts). */
const mixed = (prefix: string): Block[] => [
  call(`${prefix}1`, "Bash", "execute", { command: "bun run typecheck", description: "Typecheck the renderer" }),
  call(`${prefix}2`, "Bash", "execute", { command: "npm test", description: "npm test" }),
  call(`${prefix}3`, "Write", "edit", { file_path: `${CWD}/convex/diag.ts`, content: lines(46) }),
  call(`${prefix}4`, "Edit", "edit", { file_path: `${CWD}/convex/schema.ts`, old_string: "a\nb", new_string: lines(5) }),
  call(`${prefix}5`, "TodoWrite", "other", {
    todos: [
      { content: "Read the schema", status: "completed" },
      { content: "Add the index", status: "in_progress" },
      { content: "Run the tests", status: "pending" },
    ],
  }),
  call(`${prefix}6`, "mcp__cosmic-admin__build_get", "other", { build_id: "b-1042" }),
  {
    ...call(`${prefix}7`, "mcp__orchestrator__spawn_agent", "other", { task: "Port the view to the new board" }),
    tool: {
      callId: `${prefix}7`,
      name: "mcp__orchestrator__spawn_agent",
      kind: "other",
      status: "completed",
      input: { task: "Port the view to the new board" },
      spawned: [`${prefix}-child`],
    },
  },
  {
    id: `${prefix}8`,
    role: "system",
    text: "",
    gate: { step: "gate", branch: "port-the-view", ok: false, log: "› typecheck\n✓ typecheck 21s\n› vitest\n✗ vitest 48s\ngate failed: vitest", at: 0 },
  },
  { id: `${prefix}9`, role: "reasoning", text: "The index belongs on the table.", ts: 1, doneTs: 3001 },
];

// The harness renders with no session, so the opened state is keyed ":a:<first id>".
setEditOpen(":a:open1", true);
setEditOpen(":a:orchOpen1", true);
setEditOpen(":a:wakeOpen1", true);
setEditOpen(":a:mixed1", true);

/** A working run of `n` steps, the last still running (a thought counts as a row). */
const working = (prefix: string, n: number): Block[] =>
  Array.from({ length: n }, (_, i) =>
    i % 4 === 2
      ? ({ id: `${prefix}${i}`, role: "reasoning", text: "Checking the schema next.", ts: 1, doneTs: 2001 } as Block)
      : call(`${prefix}${i}`, i % 2 ? "Bash" : "Read", i % 2 ? "execute" : "read", i % 2 ? { command: `bun test step-${i}` } : { file_path: `${CWD}/convex/step-${i}.ts` }, i === n - 1 ? "running" : "completed"),
  );

export const fixtures: { name: string; props: { blocks: Block[]; cwd: string; live?: boolean; working?: boolean } }[] = [
  { name: "Working, 1 row (lone)", props: { blocks: working("w1-", 1), cwd: CWD, live: true, working: true } },
  { name: "Working, 2 rows", props: { blocks: working("w2-", 2), cwd: CWD, live: true, working: true } },
  { name: "Working, 5 rows", props: { blocks: working("w5-", 5), cwd: CWD, live: true, working: true } },
  { name: "Working, 9 rows (newest 5 shown)", props: { blocks: working("w9-", 9), cwd: CWD, live: true, working: true } },
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
  { name: "Orchestration run", props: { blocks: orchestration("orch"), cwd: CWD } },
  { name: "Orchestration run, opened", props: { blocks: orchestration("orchOpen"), cwd: CWD } },
  { name: "Wake run", props: { blocks: wake("wake"), cwd: CWD } },
  { name: "Wake run, opened", props: { blocks: wake("wakeOpen"), cwd: CWD } },
  { name: "Mixed calls, opened", props: { blocks: mixed("mixed"), cwd: CWD } },
  {
    name: "Thought only",
    props: {
      blocks: [{ id: "think", role: "reasoning", text: "Weighing whether the index belongs on the table.", ts: 1, doneTs: 4001 }],
      cwd: CWD,
    },
  },
];
