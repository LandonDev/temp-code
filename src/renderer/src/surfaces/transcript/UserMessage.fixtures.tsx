// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/UserMessage.tsx#UserMessageBlock`.
const base = { stickyIndex: 1, environmentId: "local" };

const at = new Date(2026, 10, 1, 14, 2).getTime();
const steered = (steer: object) => ({ ...base, block: { id: "st", role: "user", text: "Use the other table instead.", steerId: "s1", steer: { ts: at, ...steer } } });

export default [
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
