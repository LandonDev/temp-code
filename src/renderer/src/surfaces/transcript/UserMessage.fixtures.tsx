// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/UserMessage.tsx#UserMessageBlock`.
const base = { stickyIndex: 1, environmentId: "local" };

export default [
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
