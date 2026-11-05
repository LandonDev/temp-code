// One row per state of the large fleet, each under the heading its section
// draws, plus a paused agent, a Cursor agent with no effort and descendants
// one and two levels in.
import { GROUP_LABEL, groupOf } from "../../../lib/threadGroups";
import { FLEET_DESCENDANTS, FLEET_ROWS, fixtureHostGlyph, fixtureMeta, fixtureStatus } from "./fleetFixture";

const paused = fixtureMeta("ios-orch-p", { title: "Port module 13", status: "paused", frozenActiveElapsed: 312_000, tasks: { done: 1, total: 4 } });

const rows = [...FLEET_ROWS.slice(0, 3), ...FLEET_ROWS.slice(8), { meta: paused, status: fixtureStatus(paused) }];

export default [
  ...rows.map((row) => ({
    name: row.meta.title,
    props: {
      meta: row.meta,
      status: row.status,
      heading: GROUP_LABEL[groupOf(row.meta)],
      hostGlyph: fixtureHostGlyph,
      selected: row.meta.id === "ios-orch-a3",
      onOpen: "fn",
      onOpenSession: "fn",
      onStop: "fn",
    },
  })),
  {
    name: "A working agent with no heading drawn",
    props: { meta: FLEET_ROWS[0].meta, status: FLEET_ROWS[0].status, heading: null, onOpen: "fn", onOpenSession: "fn", onStop: "fn" },
  },
  {
    name: "A Cursor agent: no effort",
    props: {
      meta: FLEET_DESCENDANTS[2],
      status: fixtureStatus(FLEET_DESCENDANTS[2]),
      heading: "Done",
      depth: 1,
      onOpen: "fn",
      onOpenSession: "fn",
    },
  },
  {
    name: "A descendant, two levels in",
    props: {
      meta: FLEET_DESCENDANTS[1],
      status: fixtureStatus(FLEET_DESCENDANTS[1]),
      heading: "Done",
      depth: 2,
      onOpen: "fn",
      onOpenSession: "fn",
    },
  },
  {
    name: "A descendant, one level in",
    props: {
      meta: FLEET_DESCENDANTS[0],
      status: fixtureStatus(FLEET_DESCENDANTS[0]),
      heading: "Working",
      depth: 1,
      onOpen: "fn",
      onOpenSession: "fn",
      onStop: "fn",
    },
  },
];
