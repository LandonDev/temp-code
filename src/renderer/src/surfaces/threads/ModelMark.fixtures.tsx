// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/ModelMark.tsx#ModelMark`
// (and `#ModelLine`, which reads the same `meta`).
export default [
  { name: "Claude with its effort", props: { meta: { provider: "claude", model: "claude-opus-5-5", reasoning: "high" }, effort: true } },
  { name: "Codex with its effort", props: { meta: { provider: "codex", model: "gpt-6.1-sol", reasoning: "xhigh" }, effort: true } },
  { name: "a Meta model on the claude lane", props: { meta: { provider: "claude", model: "muse-spark-1.3", reasoning: "medium" }, effort: true } },
  { name: "a Muse Code row: Meta's symbol", props: { meta: { provider: "muse", model: "muse-spark-1.3", reasoning: "medium", context1m: false }, effort: true } },
  { name: "the name alone", props: { meta: { provider: "claude", model: "claude-sonnet-5-5", reasoning: "low" } } },
  { name: "a stand-in with no model draws nothing", props: { meta: { provider: "claude", model: null } } },
];
