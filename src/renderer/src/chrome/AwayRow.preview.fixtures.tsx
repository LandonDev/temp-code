// Fixtures for `bun run ui:preview src/renderer/src/chrome/AwayRow.preview.tsx#AwayFootPreview`:
// the foot with Away off and on.
export default [
  { name: "Off: muted like the foot's other rows", props: { enabled: false } },
  { name: "On: the amber track and moon, the label in the foreground", props: { enabled: true, at: Date.UTC(2026, 10, 5, 14, 14) } },
];
