// The Agents section drawn without a store: the large fleet on two hosts
// with a tree under the shell's builder, and a fleet that is all one section.
import { agentSections, agentTree } from "../../../lib/threads/agents";
import { AgentRowView } from "./AgentRow";
import type { SectionRow } from "./FleetPanel";
import { FLEET_TREE_METAS, fixtureHostGlyph, fixtureMeta, fixtureStatus } from "./fleetFixture";

const row = (r: SectionRow) => (
  <AgentRowView
    meta={r.meta}
    status={fixtureStatus(r.meta)}
    heading={r.heading}
    depth={r.depth}
    selected={r.selected}
    hostGlyph={fixtureHostGlyph}
    onOpen={r.onOpen}
    onOpenSession={() => {}}
    onStop={() => {}}
  />
);

const T0 = 1_761_500_000_000;
const settled = [1, 2, 3].map((n) =>
  fixtureMeta(`done-${n}`, { title: `Survey part ${n}`, agentType: "explorer", createdAt: T0 + n, lastEventAt: T0 + n * 47_000 }),
);

export default [
  {
    name: "The large fleet on two hosts",
    props: { sections: agentSections(agentTree(FLEET_TREE_METAS, "ios-orch")), selectedId: "ios-orch-a3", onOpen: "fn", row },
  },
  {
    name: "One section: no heading",
    props: { sections: agentSections(agentTree(settled, "ios-orch")), onOpen: "fn", row },
  },
  { name: "No subagents", props: { sections: [], onOpen: "fn" } },
];
