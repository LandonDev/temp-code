// Fixtures for `bun run ui:preview src/renderer/src/chrome/Composer.preview.tsx#DockedComposerPreview`:
// the docked footer at rest, with a turn running, paused with the queue, with
// attachments in the box, and with three lines in the field.
const file = (id: string, name: string, kind: "image" | "file", mimeType: string, size: number) => ({
  id,
  name,
  kind,
  mimeType,
  size,
  path: `/srv/agents/work/temp-code/${name}`,
});

export default [
  { name: "Docked, a thread with a message", props: { id: "preview-docked" } },
  { name: "Docked, a turn running 1m 32s", props: { id: "preview-running", status: "running", elapsedMs: 92_000 } },
  {
    name: "Docked, paused with two queued",
    props: {
      id: "preview-queue",
      status: "paused",
      elapsedMs: 252_000,
      queue: [
        { id: "q1", text: "Then run the tests you touched", ts: 1 },
        { id: "q2", text: "And keep the remembered draft when a pane closes, so the person never loses what they typed", ts: 2, provider: "codex", model: "gpt-6.1-sol", reasoning: "high" },
      ],
    },
  },
  {
    name: "Docked, two attachments",
    props: {
      id: "preview-attachments",
      draft: "What do these two show?",
      attachments: [file("a1", "login-error.png", "image", "image/png", 182_000), file("a2", "gateway.log", "file", "text/plain", 48_000)],
    },
  },
  {
    name: "Docked, three lines",
    props: {
      id: "preview-three-lines",
      draft: "Rework the login flow so a lapsed token asks once\nKeep the remembered draft\nThen run the tests you touched",
    },
  },
];
