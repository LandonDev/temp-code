// Fixtures for `bun run ui:preview src/renderer/src/chrome/OrchestrationRules.preview.tsx#OrchestrationRulesPreview`.
export default [
  { name: "The Mac: every provider, Muse Code's four probed rows at their defaults", props: { host: "mac" } },
  { name: "The box: Muse Code unprobed, the rules' Muse rows kept as not on this host", props: { host: "box" } },
  { name: "The Mac paired: its rules kept on the box", props: { host: "macShared" } },
  { name: "The Mac paired, the box out of reach: every control off", props: { host: "macOffline" } },
];
