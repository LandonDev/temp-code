// Fixtures for `bun run ui:preview src/renderer/src/surfaces/RightPanel.preview.tsx#PanelHeaderPreview`.
export default [
  { name: "Every section at 260px, Agents selected", props: { width: 260, sections: ["agents", "activity", "changes", "notes", "files", "build", "debug"], value: "agents" } },
  { name: "A project thread at 320px, Changes selected", props: { width: 320, sections: ["agents", "changes", "notes", "files", "build"], value: "changes" } },
  { name: "A chat at 400px, Notes alone", props: { width: 400, sections: ["notes"], value: "notes" } },
];
