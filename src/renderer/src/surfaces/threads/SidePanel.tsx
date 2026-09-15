import { motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";
import { PanelRight } from "../../chrome/icons";
import { EASE_OUT } from "../../lib/ease";
import type { SessionStatus } from "../../lib/tcserver/types";
import { MatrixSpinner, PaneHeader, StatusDot } from "./bits";

const OPEN_W = 380;
const RAIL_W = 36;

/**
 * A log docked on the right edge, folded to a slim rail by default: the
 * hero surface keeps the room and the mechanics stay one click away.
 * The body stays mounted while folded (`inert` + `invisible absolute`) so
 * a streaming transcript keeps its scroll and never re-mounts. It opens
 * at full width at once; only the content fades in.
 */
export function SidePanel({ label, status, children }: { label: string; status?: SessionStatus; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const running = status === "running" || status === "starting";

  return (
    <div
      style={{ width: open ? OPEN_W : RAIL_W }}
      className="relative flex shrink-0 overflow-hidden border-l border-content/10"
    >
      {!open ? (
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
      ) : null}
      <motion.div
        inert={!open}
        initial={false}
        animate={{ opacity: open ? 1 : 0 }}
        transition={open && !reduce ? { duration: 0.12, ease: EASE_OUT } : { duration: 0 }}
        style={{ width: OPEN_W }}
        className={`flex h-full flex-col ${open ? "" : "invisible absolute inset-y-0 right-0"}`}
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
      </motion.div>
    </div>
  );
}
