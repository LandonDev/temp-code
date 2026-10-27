// A18: the orchestration header over the large fleet, and a long goal.
import { FLEET_METAS } from "./fleetFixture";

export default [
  { name: "The large fleet", props: { goal: "Ship the iOS thread screens", agents: FLEET_METAS } },
  {
    name: "A goal longer than the column",
    props: {
      goal: "Build the shell and the thread screens in parallel, then have a reviewer read both against the desktop's rules before anything lands on master",
      agents: FLEET_METAS.slice(0, 3),
    },
  },
];
