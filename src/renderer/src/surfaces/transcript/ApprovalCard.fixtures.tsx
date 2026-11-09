// The approval's states for `bun run ui:preview src/renderer/src/surfaces/transcript/ApprovalCard.tsx#ApprovalCard`.
// Inside an open group's table: ActionGroup.fixtures.tsx "Opened, a call waiting on approval".
import type { Block } from "../../lib/session";

const approval = (decided?: "allow" | "deny", auto?: boolean): Block => ({
  id: "a",
  role: "tool",
  text: "Bash",
  tool: { callId: "a", name: "Bash", kind: "execute", title: "Bash", status: "pending", input: { command: "rm -rf build" } },
  approval: { requestId: 7, decided, auto },
});

/** A computer step that waited for the Mac to be free: Run now and Skip. */
const runSkip = (decided?: "allow" | "deny", auto?: boolean): Block => ({
  id: "s",
  role: "tool",
  text: "Click button \"Save\" in TextEdit",
  tool: { callId: "s", name: "mcp__app__computer_act", kind: "other", title: "Click button \"Save\" in TextEdit", status: "pending", input: { app: "TextEdit", action: "left_click", element: 14 } },
  approval: { requestId: 8, decided, auto, choices: "run-skip" },
});

export const fixtures: { name: string; props: { block: Block } }[] = [
  { name: "Waiting: the amber mark, Allow and Deny", props: { block: approval() } },
  { name: "Allowed", props: { block: approval("allow") } },
  { name: "Denied", props: { block: approval("deny") } },
  { name: "Denied automatically", props: { block: approval("deny", true) } },
  { name: "Waiting for the Mac: Run now and Skip", props: { block: runSkip() } },
  { name: "Ran now", props: { block: runSkip("allow") } },
  { name: "Skipped", props: { block: runSkip("deny") } },
  { name: "Skipped automatically", props: { block: runSkip("deny", true) } },
];
