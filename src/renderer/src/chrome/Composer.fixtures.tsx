// Fixtures for `bun run ui:preview src/renderer/src/chrome/Composer.tsx#Composer`:
// the box before a first message (its draft row open), three lines in the
// field, the meter amber, a draft with its row under the box, and chat
// drafts with Master thread and the name field. The docked footer of a
// thread with messages (the slot, the queue, attachments) is
// Composer.preview.tsx#DockedComposerPreview.
import type { ComponentProps } from "react";
import type { Composer } from "./Composer";

const noop = () => {};
export const composerFixtureBase: ComponentProps<typeof Composer> = {
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  cwd: "/srv/agents/work/temp-code",
  executionCwd: "/srv/agents/work/temp-code",
  sessionId: "fixture-thread",
  recents: [],
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
};
const base = composerFixtureBase;

export default [
  { name: "At rest, before the first message", props: { ...base, context: { used: 84_000, window: 200_000 } } },
  {
    name: "Three lines",
    props: {
      ...base,
      sessionId: "fixture-three-lines",
      context: { used: 84_000, window: 200_000 },
      initialDraft: "Rework the login flow so a lapsed token asks once\nKeep the remembered draft\nThen run the tests you touched",
    },
  },
  { name: "Context amber", props: { ...base, sessionId: "fixture-amber", context: { used: 176_000, window: 200_000 } } },
  { name: "Draft", props: { ...base, sessionId: undefined, shell: true, hideProjectPicker: true } },
  {
    name: "Chat draft, master thread",
    props: { ...base, sessionId: undefined, shell: true, hideProjectPicker: true, threadType: "chat", onThreadTypeChange: noop, master: true, onMasterChange: noop },
  },
  {
    name: "Chat draft, unnamed",
    props: { ...base, sessionId: undefined, shell: true, hideProjectPicker: true, threadType: "chat", onThreadTypeChange: noop, master: false, onMasterChange: noop, draftTitle: "", onDraftTitleChange: noop },
  },
  {
    name: "Chat draft, named",
    props: { ...base, sessionId: undefined, shell: true, hideProjectPicker: true, threadType: "chat", onThreadTypeChange: noop, master: false, onMasterChange: noop, draftTitle: "Gateway deadline audit", onDraftTitleChange: noop },
  },
];
