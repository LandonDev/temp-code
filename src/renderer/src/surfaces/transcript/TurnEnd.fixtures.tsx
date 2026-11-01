// Fixtures for `bun run ui:preview src/renderer/src/surfaces/transcript/TurnEnd.tsx#WatchingLine`.
const now = Date.now();
const noop = () => {};

export default [
  { name: "fresh", props: { since: now - 4 * 60_000 } },
  { name: "stale", props: { since: now - 45 * 60_000, stale: true } },
  { name: "clickable", props: { since: now - 4 * 60_000, onOpen: noop } },
  { name: "clickable and stale", props: { since: now - 45 * 60_000, stale: true, onOpen: noop } },
];
