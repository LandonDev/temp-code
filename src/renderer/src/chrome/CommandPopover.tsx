import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { addonTitle } from "../lib/addonNames";
import { SECTION_LABELS } from "../lib/composerTriggers";
import type { ProjectFile } from "../lib/fs";
import type { ProjectMeta, SessionMeta, SlashCommand } from "../lib/tcserver/types";
import { StatusMark, threadStateOf } from "../components/ui/status";
import { MENU_ROW } from "../components/ui/menu-row";
import { timeAgo } from "../lib/duration";
import { DUR } from "../lib/ease";
import { marksAtRest } from "../lib/threadStripModel";
import { AddonMark } from "./AddonMark";
import { FileText, MessageSquare, StickyNote } from "./icons";

/**
 * The composer's autocomplete, ported from temp-code's PromptBar: one flat
 * keyboard list rising above the box. `/` rows are the provider's commands
 * sectioned by source; `@` rows are project files, then threads, then notes.
 * It exists only while there is something to pick. It moves as every popup
 * does, on transitions (POPUP_MOTION): it rises 4px from the box's edge and
 * fades in, and on close keeps its last rows, inert, while it fades back
 * down, so typing past it turns it around from where it is. A row keeps its
 * element as the filter narrows; the frame's height follows the list on
 * the same transition.
 */

/** The popup recipe, risen from the box's edge below it: fade + 4px, `--dur-base` in, `--dur-fast` back a quarter of the way out; opacity alone under reduced motion. */
export const POPUP_MOTION =
  "origin-bottom transition-[opacity,translate,height] duration-(--dur-base) ease-(--ease-out) starting:opacity-0 starting:translate-y-1 data-ending-style:opacity-0 data-ending-style:translate-y-px data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-opacity";

export type AtMatch =
  | { kind: "file"; file: ProjectFile }
  | { kind: "thread"; session: SessionMeta }
  | { kind: "note"; file: ProjectFile };

export type PopoverMatches =
  | { mode: "command"; rows: SlashCommand[] }
  | { mode: "file"; rows: AtMatch[] };

/** A menu's row (MENU_ROW), its 8px radius concentric in the 12px popover's 4px inset. */
const ROW = `${MENU_ROW} flex w-full cursor-default items-center rounded-lg text-left`;
/** A thread row's glyph: its status mark when it has one at rest, else the thread glyph. */
function ThreadGlyph({ status }: { status: SessionMeta["status"] }) {
  const state = threadStateOf(status);
  return marksAtRest(state) ? <StatusMark state={state} word={false} /> : <MessageSquare className="size-3.5 text-muted-foreground" />;
}

export function CommandPopover({
  matches,
  active,
  projectId,
  projects,
  onActive,
  onAccept,
}: {
  matches: PopoverMatches | null;
  active: number;
  /** The composer's own project, so foreign threads show where they live. */
  projectId: string | null;
  projects: readonly ProjectMeta[];
  onActive: (index: number) => void;
  onAccept: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const open = !!matches && matches.rows.length > 0;
  // The rows on screen: the live ones while open, the last ones while it leaves.
  const [held, setHeld] = useState<PopoverMatches | null>(open ? matches : null);
  if (open && held !== matches) setHeld(matches);
  const ending = !open && !!held;
  const shown = open ? matches : held;

  // The frame's height is the list's, so a narrowing filter glides it.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const list = listRef.current;
    if (!frame || !list || !open) return;
    // Unmeasured (a pane not laid out), it keeps its natural height.
    const height = list.offsetHeight;
    frame.style.height = height > 0 ? `${height}px` : "";
  }, [open, matches]);

  // Gone once the fade ends; a pane that never paints it is gone after twice its time.
  useEffect(() => {
    if (!ending) return;
    const timer = setTimeout(() => setHeld(null), DUR.fast * 2000);
    return () => clearTimeout(timer);
  }, [ending]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-active=true]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  const rowProps = (n: number) => ({
    "data-active": n === active,
    role: "option",
    "aria-selected": n === active,
    onMouseEnter: () => onActive(n),
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      onAccept(n);
    },
    className: `${ROW} ${n === active ? "bg-muted" : ""}`,
  });

  if (!shown) return null;
  const rows = shown;
  return (
    <div
      ref={frameRef}
      data-command-popover
      data-ending-style={ending ? "" : undefined}
      inert={ending}
      aria-hidden={ending || undefined}
      onTransitionEnd={(e) => {
        if (ending && e.target === e.currentTarget && e.propertyName === "opacity") setHeld(null);
      }}
      className={`absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-overlay ring-1 ring-border [--scrollbar-inset:var(--radius-xl)] ${POPUP_MOTION} ${ending ? "pointer-events-none" : ""}`}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={rows.mode === "command" ? "Skills and commands" : "Files and threads"}
        className="max-h-72 overflow-y-auto overscroll-none rounded-xl p-1 [--scrollbar-inset:var(--radius-xl)]"
      >
        {rows.mode === "command"
          ? rows.rows.map((c, n) => (
              <Fragment key={`${c.scope}:${c.name}`}>
                {SECTION_LABELS[c.source] !==
                SECTION_LABELS[rows.rows[n - 1]?.source as SlashCommand["source"]] ? (
                  <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground first:pt-1">
                    {SECTION_LABELS[c.source]}
                  </p>
                ) : null}
                <div {...rowProps(n)}>
                  <AddonMark command={c} size={14} />
                  <span className="shrink-0 font-medium">
                    {c.source === "plugin" || c.source === "mcp"
                      ? addonTitle(c.name)
                      : `/${c.name}`}
                  </span>
                  {c.description ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {c.description}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                    {c.scope === "project" ? "project" : ""}
                  </span>
                </div>
              </Fragment>
            ))
          : rows.rows.map((m, n) => {
              // Grouped render over one flat keyboard list: a quiet
              // label where one kind ends and the next begins.
              const prev = rows.rows[n - 1]?.kind;
              const mixed = rows.rows.some((x) => x.kind !== m.kind);
              const label =
                mixed && prev !== m.kind && m.kind !== "file" ? (
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                    {m.kind === "thread" ? "Threads" : "Notes"}
                  </div>
                ) : null;
              if (m.kind === "file" || m.kind === "note") {
                const p = m.file.relative;
                const base = m.kind === "note" ? m.file.name : p.split("/").pop();
                const dir =
                  m.kind === "file" && p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
                const Icon = m.kind === "note" ? StickyNote : FileText;
                return (
                  <div key={m.file.path}>
                    {label}
                    <div {...rowProps(n)}>
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="shrink-0">{base}</span>
                      {dir ? (
                        <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>
                      ) : null}
                    </div>
                  </div>
                );
              }
              const t = m.session;
              const foreign = t.projectId !== projectId;
              const projectName = foreign
                ? projects.find((p) => p.id === t.projectId)?.name
                : undefined;
              return (
                <div key={t.id}>
                  {label}
                  <div {...rowProps(n)}>
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <ThreadGlyph status={t.status} />
                    </span>
                    <span className="min-w-0 truncate">{t.title}</span>
                    {projectName ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{projectName}</span>
                    ) : null}
                    <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">
                      {timeAgo(t.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
      </div>
    </div>
  );
}
