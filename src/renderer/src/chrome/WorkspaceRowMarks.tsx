import type { RefObject } from "react";
import type { CardThread } from "../lib/projectCardModel";
import type { WorkspaceRailStatus } from "../hooks/useProjectSignals";
import { Pause } from "./icons";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";
import { TerminalSpinner } from "./TerminalSpinner";

/**
 * A workspace row's marks, owned by the status area (A2): the glyph (logo
 * or mascot), the status chip and the working line under a busy row. The
 * rail (ProjectRail.tsx) places them and never styles them.
 */

/** The row's 16px glyph: the logo (set, or the repo icon) while quiet,
 *  else the mascot, tinted amber when a thread needs you. */
export function WorkspaceGlyph({
  showLogo,
  logoPath,
  workspaceId,
  projectKey,
  color,
  mascotName,
  busy,
  needsYou,
}: {
  showLogo: boolean;
  logoPath: string | null | undefined;
  workspaceId: string | null;
  projectKey: string;
  color: string;
  mascotName: string | null | undefined;
  busy: boolean;
  needsYou: boolean;
}) {
  return showLogo && !busy && !needsYou ? (
    <ProjectLogoIcon path={logoPath ?? null} workspaceId={workspaceId} className="size-4 rounded-md" imageClassName="size-4" />
  ) : (
    <ProjectMascot
      project={projectKey}
      color={needsYou ? "var(--color-warning)" : color}
      name={mascotName ?? null}
      className="size-3"
      active={busy}
    />
  );
}

/** The chip's word for each dominant workspace state, plural-aware. */
const RAIL_CHIP_LABEL: Record<NonNullable<WorkspaceRailStatus["kind"]>, string> = {
  paused: "Paused",
  needsYou: "Needs you",
  busy: "Working",
  unread: "Done",
};

function railChipTitle(status: WorkspaceRailStatus): string {
  if (!status.kind) return "";
  const word = status.count === 1 ? "thread" : "threads";
  return `${RAIL_CHIP_LABEL[status.kind]} — ${status.count} ${word}`;
}

/** One small always-visible indicator per workspace row, replacing the
 *  plain shimmer/tint as the only signal something is happening: click
 *  opens the compact per-thread breakdown. */
export function RailStatusChip({
  status,
  open,
  onToggle,
  chipRef,
}: {
  status: WorkspaceRailStatus;
  open: boolean;
  onToggle: () => void;
  chipRef: RefObject<HTMLButtonElement | null>;
}) {
  if (!status.kind) return null;
  return (
    <button
      ref={chipRef}
      type="button"
      data-no-drag
      title={railChipTitle(status)}
      aria-label={railChipTitle(status)}
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={`pressable grid size-4 shrink-0 place-items-center rounded ${
        open ? "bg-content/10" : "hover:bg-content/10"
      }`}
    >
      {status.kind === "paused" ? (
        <Pause className="size-2.5 fill-current text-warning" strokeWidth={1.75} />
      ) : status.kind === "needsYou" ? (
        <span className="size-1.5 rounded-full bg-warning" />
      ) : status.kind === "busy" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      ) : (
        <span className="size-1.5 rounded-full bg-info" />
      )}
    </button>
  );
}

/** What a busy workspace is doing, indented under its row: no chip, no
 *  popover to open — the running thread's own name says it. Several
 *  threads working name the loudest one and count the rest. */
export function WorkspaceWorkingLine({
  running,
  onSelect,
}: {
  running: CardThread[];
  onSelect?: (sessionId: string) => void;
}) {
  const [first, ...rest] = running;
  if (!first) return null;
  return (
    <button
      type="button"
      data-no-drag
      title={running.map((t) => t.title || "Untitled").join("\n")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(first.id);
      }}
      className="pressable flex h-6 w-full items-center gap-1.5 rounded-md py-0.5 pr-2 pl-8 text-left text-[11px] leading-tight text-content/50 hover:bg-content/5 hover:text-content"
    >
      <TerminalSpinner />
      <span className="min-w-0 flex-1 truncate">{first.title || "Untitled"}</span>
      {rest.length > 0 ? (
        <span className="shrink-0 tabular-nums text-content/40">+{rest.length}</span>
      ) : null}
    </button>
  );
}

