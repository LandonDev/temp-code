// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/ActivitySection.tsx#ActivityRows`.
import { activityRows } from "../../lib/activity";
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
const rows = activityRows({ meta, agents: [{ busySince: now - 5 * 60_000, createdAt: 0 }], devServers: [server], macCalls: [] });

export default [{ name: "a watching thread's activity", props: { threadId: "s1", rows, meta, onOpenAgents: () => {} } }];
