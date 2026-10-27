import { Fragment, useEffect, useRef } from "react";
import { addonTitle } from "../lib/addonNames";
import { SECTION_LABELS } from "../lib/composerTriggers";
import type { ProjectFile } from "../lib/fs";
import type { ProjectMeta, SessionMeta, SlashCommand } from "../lib/tcserver/types";
import { StatusMark, threadStateOf } from "../components/ui/status";
import { timeAgo } from "../lib/duration";
import { marksAtRest } from "../lib/threadStripModel";
import { AddonMark } from "./AddonMark";
import { FileText, MessageSquare, StickyNote } from "./icons";

/**
 * The composer's autocomplete, ported from temp-code's PromptBar: one flat
 * keyboard list rising above the box. `/` rows are the provider's commands
 * sectioned by source; `@` rows are project files, then threads, then notes.
 * It exists only while there is something to pick, and opens with no
 * motion: it answers a keystroke.
 */

export type AtMatch =
  | { kind: "file"; file: ProjectFile }
  | { kind: "thread"; session: SessionMeta }
  | { kind: "note"; file: ProjectFile };

export type PopoverMatches =
  | { mode: "command"; rows: SlashCommand[] }
  | { mode: "file"; rows: AtMatch[] };

const ROW = "flex h-7 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-[13px]";
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
  const open = !!matches && matches.rows.length > 0;

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

  if (!open) return null;
  return (
    <div
      data-command-popover
      className="absolute right-0 bottom-full left-0 z-30 mb-2 rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay"
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={matches.mode === "command" ? "Skills and commands" : "Files and threads"}
        className="max-h-72 overflow-y-auto overscroll-none rounded-xl p-1"
      >
        {matches.mode === "command"
          ? matches.rows.map((c, n) => (
              <Fragment key={`${c.scope}:${c.name}`}>
                {SECTION_LABELS[c.source] !==
                SECTION_LABELS[matches.rows[n - 1]?.source as SlashCommand["source"]] ? (
                  <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground first:pt-1">
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
                  <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">
                    {c.scope === "project" ? "project" : ""}
                  </span>
                </div>
              </Fragment>
            ))
          : matches.rows.map((m, n) => {
              // Grouped render over one flat keyboard list: a quiet
              // label where one kind ends and the next begins.
              const prev = matches.rows[n - 1]?.kind;
              const mixed = matches.rows.some((x) => x.kind !== m.kind);
              const label =
                mixed && prev !== m.kind && m.kind !== "file" ? (
                  <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
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
                    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
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
