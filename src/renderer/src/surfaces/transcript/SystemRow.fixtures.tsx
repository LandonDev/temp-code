// A handoff's line for the static render harness: `bun run ui:preview src/renderer/src/surfaces/transcript/SystemRow.tsx#HandoffDivider`.
import type { Block } from "../../lib/session";

const handoff = (id: string, to: "codex" | "claude", status: "preparing" | "ready"): Block =>
  ({ id, role: "handoff", text: "", handoff: { from: to === "codex" ? "claude" : "codex", to, status } }) as Block;

export const fixtures: { name: string; props: { block: Block } }[] = [
  { name: "Preparing a handoff (working's still dot, the words shimmer)", props: { block: handoff("h1", "codex", "preparing") } },
  { name: "Continued with Codex", props: { block: handoff("h2", "codex", "ready") } },
  { name: "Continued with Claude Code", props: { block: handoff("h3", "claude", "ready") } },
];
