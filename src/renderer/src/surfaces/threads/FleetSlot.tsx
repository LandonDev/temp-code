import { FleetPanel } from "./fleet/FleetPanel";
import type { OpenFileFn } from "../../lib/search";

/** The subagent panel beside a chat, planning or research thread. */
export function FleetSlot(props: {
  sessionId: string;
  parentCwd: string;
  onOpenSession?: (sessionId: string) => void;
  onOpenFile?: OpenFileFn;
  onOpenDiff?: (path?: string) => void;
}) {
  return <FleetPanel {...props} />;
}
