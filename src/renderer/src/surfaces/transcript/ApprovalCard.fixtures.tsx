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

export const fixtures: { name: string; props: { block: Block } }[] = [
  { name: "Waiting: the amber mark, Allow and Deny", props: { block: approval() } },
  { name: "Allowed", props: { block: approval("allow") } },
  { name: "Denied", props: { block: approval("deny") } },
  { name: "Denied automatically", props: { block: approval("deny", true) } },
];
