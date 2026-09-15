import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef } from "react";
import { addonTitle } from "../lib/addonNames";
import { SECTION_LABELS } from "../lib/composerTriggers";
import { EASE_OUT, SPRING_PANEL } from "../lib/ease";
import type { ProjectFile } from "../lib/fs";
import type { ProjectMeta, SessionMeta, SlashCommand } from "../lib/tcserver/types";
import { StatusDot, timeAgo } from "../surfaces/threads/bits";
import { AddonMark } from "./AddonMark";
import { FileText, MessageSquare, StickyNote } from "./icons";

/**
 * The composer's autocomplete, ported from temp-code's PromptBar: one flat
 * keyboard list rising above the box. `/` rows are the provider's commands
 * sectioned by source; `@` rows are project files, then threads, then notes.
 * It exists only while there is something to pick.
 */

export type AtMatch =
  | { kind: "file"; file: ProjectFile }
  | { kind: "thread"; session: SessionMeta }
  | { kind: "note"; file: ProjectFile };

export type PopoverMatches =
  | { mode: "command"; rows: SlashCommand[] }
  | { mode: "file"; rows: AtMatch[] };

const ROW = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left";
const QUIET_STATUSES = new Set(["running", "waiting", "error", "starting"]);

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
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const open = !!matches && matches.rows.length > 0;

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-active=true]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  const rowProps = (n: number) => ({
    "data-active": n === active,
    onMouseEnter: () => onActive(n),
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      onAccept(n);
    },
    className: `${ROW} ${n === active ? "bg-content/10" : ""}`,
  });

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key={matches.mode}
          data-command-popover
          initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_PANEL }}
          exit={
            reduce
              ? undefined
              : { opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.1, ease: EASE_OUT } }
          }
          style={{ transformOrigin: "bottom left" }}
          className="absolute right-0 bottom-full left-0 z-30 mb-2 rounded-xl shadow-[0_4px_24px_rgb(0_0_0/0.24)] glass-surface floating-surface"
        >
          <div
            ref={listRef}
            className="max-h-72 overflow-y-auto overscroll-none rounded-xl p-1"
          >
            {matches.mode === "command"
              ? matches.rows.map((c, n) => (
                  <Fragment key={`${c.scope}:${c.name}`}>
                    {SECTION_LABELS[c.source] !==
                    SECTION_LABELS[matches.rows[n - 1]?.source as SlashCommand["source"]] ? (
                      <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase first:pt-1">
                        {SECTION_LABELS[c.source]}
                      </p>
                    ) : null}
                    <button type="button" {...rowProps(n)}>
                      <AddonMark command={c} size={14} />
                      <span className="shrink-0 text-[13px] font-medium">
                        {c.source === "plugin" || c.source === "mcp"
                          ? addonTitle(c.name)
                          : `/${c.name}`}
                      </span>
                      {c.description ? (
                        <span className="min-w-0 truncate text-xs text-content/50">
                          {c.description}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 pl-2 text-[11px] text-content/40">
                        {c.scope === "project" ? "project" : ""}
                      </span>
                    </button>
                  </Fragment>
                ))
              : matches.rows.map((m, n) => {
                  // Grouped render over one flat keyboard list: a quiet
                  // label where one kind ends and the next begins.
                  const prev = matches.rows[n - 1]?.kind;
                  const mixed = matches.rows.some((x) => x.kind !== m.kind);
                  const label =
                    mixed && prev !== m.kind && m.kind !== "file" ? (
                      <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-content/40">
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
                        <button type="button" {...rowProps(n)}>
                          <Icon className="size-3.5 shrink-0 text-content/50" />
                          <span className="shrink-0 text-[13px]">{base}</span>
                          {dir ? (
                            <span className="min-w-0 truncate text-xs text-content/40">{dir}</span>
                          ) : null}
                        </button>
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
                      <button type="button" {...rowProps(n)}>
                        <span className="flex size-3.5 shrink-0 items-center justify-center">
                          <StatusDot status={t.status} className="size-2" />
                          {!QUIET_STATUSES.has(t.status) ? (
                            <MessageSquare className="size-3.5 text-content/50" />
                          ) : null}
                        </span>
                        <span className="min-w-0 truncate text-[13px]">{t.title}</span>
                        {projectName ? (
                          <span className="shrink-0 text-xs text-content/40">{projectName}</span>
                        ) : null}
                        <span className="ml-auto shrink-0 pl-2 text-[11px] text-content/40">
                          {timeAgo(t.updatedAt)}
                        </span>
                      </button>
                    </div>
                  );
                })}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
