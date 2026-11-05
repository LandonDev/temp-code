// The Agents section drawn without a store: the large fleet on two hosts
// with a tree under the shell's builder, a fleet that is all one section,
// and long titles on two hosts across three providers and both windows.
import { createElement } from "react";
import { CloudServer, Laptop } from "../../../chrome/icons";
import type { HostGlyphOf } from "../ModelMark";
import { agentSections, agentTree } from "../../../lib/threads/agents";
import { AgentRowView } from "./AgentRow";
import type { SectionRow } from "./FleetPanel";
import { BOX, FLEET_TREE_METAS, fixtureHostGlyph, fixtureMeta, fixtureStatus } from "./fleetFixture";

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

/** Both hosts drawn, as with two hosts paired: the Mac's laptop, the box's server. */
const bothHostGlyphs: HostGlyphOf = (environmentId) =>
  createElement(
    "span",
    { role: "img", "aria-label": environmentId === BOX ? "The box" : "This Mac", "data-host-glyph": environmentId, className: "inline-flex shrink-0 text-muted-foreground" },
    createElement(environmentId === BOX ? CloudServer : Laptop, { className: "size-3" }),
  );

const now = Date.now();
const long = [
  fixtureMeta("long-1", {
    title: "Rebuild the right panel's Agents rows so the model sits on its own line",
    status: "running",
    activity: "Editing AgentRow.tsx",
    busySince: now - 151_000,
    tasks: { done: 3, total: 7 },
    context1m: true,
  }),
  fixtureMeta("long-2", {
    title: "Review the gateway relay against a client that hangs up mid-answer",
    agentType: "reviewer",
    status: "running",
    environmentId: BOX,
    provider: "codex",
    model: "gpt-6.1-sol",
    reasoning: "xhigh",
    context: { tokens: 41_000, window: 272_000 },
    busySince: now - 48_000,
  }),
  fixtureMeta("long-3", {
    title: "Find every place the host glyph is drawn beside a title",
    agentType: "explorer",
    status: "running",
    environmentId: BOX,
    provider: "cursor",
    model: "composer-2.5",
    reasoning: undefined,
    busySince: now - 20_000,
  }),
  fixtureMeta("long-4", {
    title: "Measure the panel at its narrowest width with every row settled",
    agentType: "explorer",
    model: "claude-sonnet-5-5",
    reasoning: "low",
    createdAt: T0,
    lastEventAt: T0 + 74_000,
  }),
];

const longRow = (r: SectionRow) => (
  <AgentRowView
    meta={r.meta}
    status={fixtureStatus(r.meta)}
    heading={r.heading}
    depth={r.depth}
    hostGlyph={bothHostGlyphs}
    onOpen={r.onOpen}
    onOpenSession={() => {}}
    onStop={() => {}}
  />
);
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
  {
    name: "Long titles on two hosts, three providers, both windows",
    props: { sections: agentSections(agentTree(long, "ios-orch")), onOpen: "fn", row: longRow },
  },
  { name: "No subagents", props: { sections: [], onOpen: "fn" } },
];
