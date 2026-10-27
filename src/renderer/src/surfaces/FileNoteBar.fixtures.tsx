export default [
  { name: "read-only preview with action", props: { note: { text: "Mac copy differs: on branch main here", action: { label: "Open the Mac copy anyway", editor: { path: "/x", line: 1 } } }, readOnly: true } },
  { name: "read-only, no action", props: { note: { text: "No Mac copy" }, readOnly: true } },
  { name: "launcher failed (writable)", props: { note: { text: "IntelliJ IDEA could not be launched: the command idea is not on PATH" } } },
];
