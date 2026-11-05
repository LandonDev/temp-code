// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/UserMessage.tsx#UserMessageBlock`.
const base = { stickyIndex: 1, environmentId: "local" };

const at = new Date(2026, 10, 1, 14, 2).getTime();
const steered = (steer: object) => ({ ...base, block: { id: "st", role: "user", text: "Use the other table instead.", steerId: "s1", steer: { ts: at, ...steer } } });

const long = [
  "Pick up the toast inset from @thread:t-strip where it left off, then:",
  ...Array.from({ length: 13 }, (_, i) => `${i + 1}. Step ${i + 1} of the pass, one line each so the bubble clamps at twelve.`),
].join("\n");

export default [
  {
    // A brief with its project rules folded above, two files, a thread chip and more than twelve lines (T-A10).
    name: "a brief: project rules, attachments, a thread chip, past twelve lines",
    props: {
      ...base,
      block: {
        id: "b",
        role: "user",
        text: long,
        preamble: { text: "Work in your own worktree.\nRun typecheck and the tests you touched.", words: 212 },
        attachments: [
          { id: "a1", name: "stalls.log", mimeType: "text/plain", kind: "file", size: 48_213 },
          { id: "a2", name: "trace.json", mimeType: "application/json", kind: "file", size: 912_004 },
        ],
      },
    },
  },
  { name: "steer sent", props: steered({ state: "sent" }) },
  { name: "steer received", props: steered({ state: "received", how: "in-turn" }) },
  { name: "steer queued", props: steered({ state: "queued" }) },
  { name: "steer not delivered", props: steered({ state: "failed", reason: "the harness did not start" }) },
  {
    name: "second opinion",
    props: { ...base, block: { id: "s", role: "user", text: "", secondOpinion: { from: "claude", to: "codex", files: 3 } } },
  },
  {
    name: "handoff",
    props: {
      ...base,
      block: { id: "h", role: "user", text: "Carry on with the toast inset; the strip is done.", secondOpinion: { from: "claude", to: "codex", kind: "handoff" } },
    },
  },
];
