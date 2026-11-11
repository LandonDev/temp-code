// Fixtures for `bun run ui:preview src/renderer/src/surfaces/RightPanel.preview.tsx#PanelHeaderPreview`.
export default [
  // Eight 28px segments need 238px of the 203px a 260px panel has: they draw 24px wide with no gap.
  { name: "Eight sections at 260px, compact, Computer selected", props: { width: 260, sections: ["agents", "activity", "computer", "changes", "notes", "files", "build", "debug"], value: "computer" } },
  { name: "Eight sections at 320px keep their 28px", props: { width: 320, sections: ["agents", "activity", "computer", "changes", "notes", "files", "build", "debug"], value: "computer" } },
  { name: "Seven sections at 260px, compact, Agents selected", props: { width: 260, sections: ["agents", "activity", "changes", "notes", "files", "build", "debug"], value: "agents" } },
  { name: "A project thread at 320px, Changes selected", props: { width: 320, sections: ["agents", "changes", "notes", "files", "build"], value: "changes" } },
  { name: "A chat at 400px, Notes alone", props: { width: 400, sections: ["notes"], value: "notes" } },
];
