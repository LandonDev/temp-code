// Fixtures for `bun run ui:preview src/renderer/src/chrome/Composer.tsx#Composer`:
// the docked box at rest, and with a draft's row under it.
const noop = () => {};
const base = {
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

export default [
  { name: "Docked", props: { ...base, context: { used: 84_000, window: 200_000 } } },
  { name: "Draft", props: { ...base, sessionId: undefined, shell: true, hideProjectPicker: true } },
];
