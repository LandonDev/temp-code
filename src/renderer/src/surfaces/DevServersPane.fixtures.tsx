// Fixtures for `bun run ui:preview src/renderer/src/surfaces/DevServersPane.tsx#DevServerColumn`:
// the pane's left column, the starter over the servers grouped by thread.
import type { DevTarget } from "@server/shared/contract-devservers";
import type { LiveServer } from "../lib/devServers";

const now = Date.now();
const web: DevTarget = { id: "apps/web#dev", name: "web", script: "dev", kind: "web", framework: "vite", dir: "apps/web", command: "bun run dev", macOnly: false, what: "Vite dev server" };
const starter = { hosts: [{ environmentId: "env_box", name: "box", projectId: "p9" }], envId: "env_box", pickHost: "fn", targets: [web], target: web, pickTarget: "fn", starting: false, error: null, asking: false, run: "fn", answer: "fn" };
const server = (key: string, sessionId: string, owner: string, title: string, port: number, mac?: number): LiveServer => ({
  key,
  environmentId: "env_box",
  title,
  sessionId,
  owner,
  port: { number: port, environmentId: "env_box", forwards: mac ? [{ environmentId: "env_mac", hostName: "Mac", macPort: mac, error: null }] : undefined },
  runId: key.endsWith("run1") ? "run1" : null,
  resource: key.endsWith("run1") ? null : { id: key.split("/")[1], sessionId },
  callId: null,
  command: "bun run dev",
  startedAt: now - 60_000,
});
const servers = [
  server("env_box/run1", "t1", "Coins page", "Vite dev server", 5173, 5174),
  server("env_box/res1", "t1", "Coins page", "Bun server", 3007),
  server("env_box/res2", "t2", "cosmicweb", "Next.js dev server", 3000),
];

export default [
  { name: "two threads' servers, the newest picked", props: { starter, servers, shownKey: "env_box/run1", onPick: "fn" } },
  { name: "nothing running", props: { starter, servers: [], shownKey: null, onPick: "fn" } },
];
