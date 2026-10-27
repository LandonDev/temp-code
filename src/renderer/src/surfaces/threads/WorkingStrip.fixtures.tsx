// Fixtures for `bun run ui:preview src/renderer/src/surfaces/threads/WorkingStrip.tsx#WorkingStrip`.
import { newSession, type Session } from "../../lib/session";

const now = Date.now();
const session = (over: Partial<Session>): Session => ({ ...newSession("env-local"), ...over });
const noop = () => {};

export default [
  {
    name: "working",
    props: { session: session({ status: "running", activity: "Running bun test", busySince: now - 92_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "paused",
    props: { session: session({ status: "paused", frozenActiveElapsed: 250_000 }), onStop: noop, onResume: noop },
  },
  {
    name: "watching one task",
    props: {
      session: session({
        status: "watching",
        background: {
          tasks: [{ id: "t", label: "Sleep 45 seconds in the background", kind: "shell", startedAt: now }],
          agents: [],
          batch: null,
          watchingSince: now - 4 * 60_000,
        },
      }),
      onStop: noop,
      onResume: noop,
      onOpenActivity: noop,
    },
  },
];
