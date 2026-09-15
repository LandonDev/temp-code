import { useState, type ReactNode } from "react";
import { Drawer } from "../../chrome/Drawer";
import { PanelRight } from "../../chrome/icons";
import type { SessionStatus } from "../../lib/tcserver/types";
import { MatrixSpinner, PaneHeader, StatusDot } from "./bits";

const OPEN_W = 380;
const RAIL_W = 36;

/**
 * A log docked on the right edge, folded to a slim rail by default: the
 * hero surface keeps the room and the mechanics stay one click away. It is
 * a push drawer: the shell widens from the rail and the body slides in at
 * its full width. The body stays mounted while folded (inert, invisible) so
 * a streaming transcript keeps its scroll and never re-mounts.
 */
export function SidePanel({ label, status, children }: { label: string; status?: SessionStatus; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const running = status === "running" || status === "starting";

  return (
    <Drawer
      open={open}
      width={OPEN_W}
      closedWidth={RAIL_W}
      keepMounted
      className="border-l border-content/10"
      closed={
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={label}
          aria-label={`Expand ${label}`}
          className="group flex h-full flex-col items-center gap-3 pt-2.5 text-content/50 transition-colors hover:bg-content/5 hover:text-content"
          style={{ width: RAIL_W }}
        >
          <PanelRight className="size-4" strokeWidth={1.75} />
          <span
            className="text-[11px] font-medium tracking-[0.08em] uppercase transition-colors"
            style={{ writingMode: "vertical-rl" }}
          >
            {label}
          </span>
          <StatusDot status={status} />
        </button>
      }
    >
      <PaneHeader label={label}>
        {running ? <MatrixSpinner cell={2} /> : null}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={`Collapse ${label}`}
          className="pressable grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/5 hover:text-content"
        >
          <PanelRight className="size-3.5" strokeWidth={1.75} />
        </button>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Drawer>
  );
}
