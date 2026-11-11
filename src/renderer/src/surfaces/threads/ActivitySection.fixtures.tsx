// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/ActivitySection.tsx#ActivityRows`.
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { activityRows } from "../../lib/activity";
import type { ComputerEntry } from "../../lib/computerSessions";
import type { LiveServer } from "../../lib/devServers";

const now = Date.now();
const meta = {
  id: "s1",
  status: "watching" as const,
  background: {
    tasks: [
      { id: "t1", label: "Sleep 90 seconds in the background", kind: "shell" as const, startedAt: now - 12 * 60_000, command: "sleep 90" },
      { id: "m1", label: "Tail the deploy log", kind: "monitor" as const, startedAt: now - 3 * 60_000 },
    ],
    agents: ["a1", "a2"],
    batch: null,
    watchingSince: now - 12 * 60_000,
  },
};
const server = {
  key: "env/r1",
  environmentId: "env",
  title: "Vite dev server",
  sessionId: "s1",
  owner: "T",
  port: { number: 5173, environmentId: "env", forwards: undefined },
  runId: null,
  resource: { id: "r1", sessionId: "s1" },
  callId: null,
  command: "bun run dev",
  startedAt: now - 60_000,
} satisfies LiveServer;
const rows = activityRows({ meta, devServers: [server], macCalls: [] });

const working = { id: "s1", status: "running" as const, background: { tasks: [], agents: [], batch: null, watchingSince: null } };
const session = (threadId: string, over: Partial<ComputerSessionRow>): ComputerEntry => ({
  host: "env_box",
  row: { threadId, since: now - 4 * 60_000, lastCallAt: now, apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Untitled" }], running: null, tier: "ax", ...over },
  previewable: false,
});
const tiers = activityRows({
  meta: working,
  devServers: [],
  macCalls: [],
  computer: [
    session("s1", {}),
    session("sub1", { since: now - 2 * 60_000, apps: [{ name: "Mail", bundleId: "com.apple.mail", window: "New Message" }], tier: "process" }),
    session("sub2", { since: now - 60_000, apps: [{ name: "Finder", bundleId: "com.apple.finder", window: null }], tier: "session" }),
    session("sub4", { since: now - 45_000, apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", window: "Total.txt" }], tier: "front" }),
    session("sub3", { since: now - 30_000, apps: [], tier: null }),
  ],
});
const held = session("s1", { running: { tool: "computer_act", words: "Waiting for the Mac to be free, 2nd in line", startedAt: now, held: true } });
const asking = session("s1", { asking: { line: "Click Save in TextEdit?" }, tier: "process" });
const heldRows = activityRows({ meta: working, devServers: [], macCalls: [], computer: [held] });
const askingRows = activityRows({ meta: working, devServers: [], macCalls: [], computer: [asking] });

export default [
  { name: "a watching thread's activity", props: { threadId: "s1", rows, meta } },
  { name: "computer rows, one per tier word, beside a shell row", props: { threadId: "s1", rows: [...rows.filter((r) => r.kind === "shell"), ...tiers], meta: working } },
  { name: "a computer row open on a card waiting on the Mac", props: { threadId: "s1", rows: askingRows, meta: working, initialOpen: askingRows[0].key } },
  { name: "a computer row open on a held step", props: { threadId: "s1", rows: [...rows.filter((r) => r.kind === "shell"), ...heldRows], meta: working, initialOpen: heldRows[0].key } },
];
