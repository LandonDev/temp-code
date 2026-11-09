import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";

/** The group's states for ui:preview: computer use off and on, and unavailable on this Mac. */
const host = (over: Partial<MacBridgeHostPolicy>): MacBridgeHostPolicy => ({
  environmentId: "env_box",
  name: "box",
  policy: "read+run",
  shared: [],
  showRunning: true,
  registered: true,
  maxRunning: 4,
  maxThreads: 2,
  running: 0,
  held: 0,
  threads: 0,
  computer: false,
  computerUnavailable: null,
  maxComputer: 2,
  computerLive: 0,
  ...over,
});

export default [
  { name: "Computer use off", props: { host: host({}) } },
  { name: "Computer use on", props: { host: host({ computer: true, computerLive: 1 }) } },
  { name: "Unavailable on this Mac", props: { host: host({ computerUnavailable: "tc-computer is not built" }) } },
];
