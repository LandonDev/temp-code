// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/WorkingStrip.tsx#WorkingStrip`.
import type { Block } from "../../lib/session";
import { newSession, type Session } from "../../lib/session";

const now = Date.now();
const session = (over: Partial<Session>): Session => ({ ...newSession("env-local"), ...over });
const noop = () => {};
const approval = {
  id: "b-r1",
  role: "tool",
  kind: "tool",
  tool: { name: "Bash", kind: "execute", title: "Bash", input: { command: "bun test" } },
  title: "Bash",
  text: "",
  approval: { requestId: "r1", decided: false },
} as unknown as Block;

export default [
  {
    name: "working",
    props: { session: session({ status: "running", activity: "Running bun test", busySince: now - 92_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "waiting on an approval",
    props: { session: session({ status: "waiting", busySince: now - 41_000, blocks: [approval] }), onStop: noop, onResume: noop },
  },
  {
    name: "paused",
    props: { session: session({ status: "paused", frozenActiveElapsed: 250_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "stopped",
    props: { session: session({ status: "stopped", frozenActiveElapsed: 95_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "queued",
    props: { session: session({ status: "queued", activity: "Queued  3rd in line" }), onStop: noop, onResume: noop, onStart: noop },
  },
];
