// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/ThinkingRow.tsx#ThinkingTail`:
// the working line's words before a turn's first content, and while it waits on its agents.
export default [
  { name: "sending", props: { word: "Sending" } },
  { name: "cold start", props: { word: "Starting the CLI" } },
  { name: "provider wait", props: { word: "Waiting for the provider, 25 s" } },
  { name: "retry", props: { word: "Rate limited, retry 2 in 30 s" } },
  { name: "thinking", props: { word: "Thinking" } },
  { name: "waiting on a subagent", props: { word: "Waiting on Review the perf pass" } },
  { name: "waiting on several", props: { word: "Waiting on 3 subagents" } },
];
