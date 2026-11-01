// The running task's steps for `bun run ui:preview`: an edit with its
// counts, a command, and a read still running, as an agent leaves them.
import type { Block } from "../../lib/session";

const CWD = "/srv/agents/work/temp-code";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i)}`).join("\n");
const call = (id: string, name: string, kind: string, input: unknown, status = "completed"): Block => ({
  id,
  role: "tool",
  text: name,
  tool: { callId: id, name, kind, title: name, status, input },
});

export const STEPS: Block[] = [
  call("s1", "Edit", "edit", { file_path: `${CWD}/src/renderer/src/surfaces/threads/SplitShell.tsx`, old_string: lines(4), new_string: lines(18) }),
  call("s2", "Bash", "execute", { command: "bun run typecheck" }),
  call("s3", "Read", "read", { file_path: `${CWD}/src/renderer/src/components/ui/task-list.tsx` }, "in_progress"),
];

export default [
  { name: "three steps, the last running", props: { sessionId: "fixture", steps: STEPS, cwd: CWD } },
  { name: "one step", props: { sessionId: "fixture", steps: STEPS.slice(1, 2), cwd: CWD } },
];
