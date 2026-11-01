// Fixtures for `bun run ui:preview src/renderer/src/surfaces/CompactionCard.tsx#CompactionCard`:
// a compaction's row in each of its four phases.
import type { Block } from "../lib/session";

const block = (text: string, compaction: Block["compaction"]): Block => ({ id: "c", role: "system", text, compaction });
const now = Date.now();

export default [
  { name: "running, 42s in", props: { block: block("Compacting context", { phase: "start", startedAt: now - 42_000 }) } },
  {
    name: "done",
    props: { block: block("Context compacted", { phase: "done", preTokens: 414_000, postTokens: 3_600, durationMs: 89_000, startedAt: now - 89_000 }) },
  },
  { name: "failed", props: { block: block("Compaction failed", { phase: "failed", error: "the conversation is too long to summarize" }) } },
  { name: "stopped", props: { block: block("Compaction stopped", { phase: "stopped", startedAt: now - 64_000, endedAt: now }) } },
];
