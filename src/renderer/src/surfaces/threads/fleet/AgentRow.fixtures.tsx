// A18: one row per state of the large fleet, for a static look at the rows.
import { FLEET_ROWS } from "./fleetFixture";

export default FLEET_ROWS.map((row) => ({
  name: row.meta.title,
  props: { meta: row.meta, status: row.status, selected: row.meta.id === "ios-orch-a3", onOpen: "fn" },
}));
