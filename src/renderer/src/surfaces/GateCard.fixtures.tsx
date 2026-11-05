// A gate run's lines for `bun run ui:preview src/renderer/src/surfaces/GateCard.tsx#GateCard`.
import type { GateNotice } from "@server/shared/gate";
import type { Block } from "../lib/session";

const gate = (g: Omit<GateNotice, "at">): { block: Block } => ({ block: { id: g.branch + g.step, role: "system", text: "", gate: { ...g, at: 0 } } });

export const fixtures: { name: string; props: { block: Block } }[] = [
  { name: "Gate passed", props: gate({ step: "gate", branch: "master", ok: true, log: "✓ typecheck 21s\n✓ vitest 48s" }) },
  { name: "Release passed, its tag", props: gate({ step: "release", branch: "master", ok: true, log: "tag release-277" }) },
  {
    name: "Typecheck failed, its count (the log behind the caret)",
    props: gate({ step: "typecheck", branch: "port-the-view", ok: false, log: "src/a.ts(3,1): error TS2322: wrong\nsrc/b.ts(9,2): error TS2345: also wrong\nFound 2 errors in 2 files." }),
  },
  { name: "Gate failed at vitest", props: gate({ step: "gate", branch: "port-the-view", ok: false, log: "› typecheck\n✓ typecheck 21s\n› vitest\n✗ vitest 48s\ngate failed: vitest" }) },
];
