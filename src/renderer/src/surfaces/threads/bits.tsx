import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { GitFork, ListChecks, MapIcon, MessageSquare, Search, Telescope, Users, Wrench } from "../../chrome/icons";
import type { ActivityKind } from "../../lib/session";
import type { AgentType, SessionStatus, ThreadType } from "../../lib/tcserver/types";

/**
 * The small shared pieces every thread view leans on: the type glyphs,
 * labels and tints, the status dot, time formatters, and the matrix
 * spinner that is the app's one busy motif.
 */

type Glyph = typeof MessageSquare;

export const THREAD_TYPES: ThreadType[] = [
  "chat",
  "planning",
  "implementation",
  "orchestration",
  "research",
];

export const THREAD_GLYPHS: Record<ThreadType, Glyph> = {
  chat: MessageSquare,
  planning: MapIcon,
  implementation: ListChecks,
  orchestration: GitFork,
  research: Telescope,
};

export const THREAD_LABELS: Record<ThreadType, string> = {
  chat: "Chat",
  planning: "Plan",
  implementation: "Implement",
  orchestration: "Orchestrate",
  research: "Research",
};

/** Identity tint per thread type — the glyph carries it, nothing else. */
export const THREAD_TINTS: Record<ThreadType, string> = {
  chat: "text-info",
  planning: "text-violet",
  implementation: "text-success",
  orchestration: "text-warning",
  research: "text-cyan",
};

/** Subagent glyph by role, for fleet rows and nested sidebar rows. */
export const AGENT_GLYPHS: Record<AgentType, Glyph> = {
  orchestrator: Users,
  implementer: Wrench,
  reviewer: ListChecks,
  explorer: Search,
};

export const THREAD_HINTS: Record<ThreadType, string> = {
  chat: "Ask questions, explore the code",
  planning: "Produce a plan document to implement from",
  implementation: "Execute a task, todos in focus",
  orchestration: "Spawn and direct subagents",
  research: "Investigate with parallel explorers, produce a cited report",
};

/** The one place status → colour lives. Dots carry meaning; nothing else is coloured. */
export function StatusDot({
  status,
  className = "",
}: {
  status: SessionStatus | undefined;
  className?: string;
}) {
  const color: Partial<Record<SessionStatus, string>> = {
    running: "bg-success motion-safe:animate-pulse",
    waiting: "bg-warning motion-safe:animate-pulse",
    error: "bg-danger",
    starting: "bg-content/50 motion-safe:animate-pulse",
  };
  const c = status ? color[status] : undefined;
  if (!c) return null;
  return <span className={`size-1.5 shrink-0 rounded-full ${c} ${className}`} />;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** Re-render every `ms` while `active` — drives live elapsed labels. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const shown = usePaneVisible();
  useEffect(() => {
    if (!active || !shown) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, shown, ms]);
  return now;
}

/** 750ms diagonal wave over a 3×3 matrix of cells. `tint` recolours the
 *  cells by what the thread is doing: pink while investigating, green
 *  while editing, the busy pink-gray while thinking. */
export function MatrixSpinner({
  cell = 2.5,
  tint,
}: {
  cell?: number;
  tint?: ActivityKind | null;
}) {
  const tintClass =
    tint === "investigate" ? "bg-busy" : tint === "edit" ? "bg-success" : "bg-busy";
  const reduce = useReducedMotion();
  return (
    <span className="grid shrink-0 grid-cols-3" style={{ gap: cell * 0.6 }}>
      {Array.from({ length: 9 }, (_, n) => {
        const diag = (n % 3) + Math.floor(n / 3);
        return (
          <span
            key={n}
            className={`z-matrix-cell rounded-[0.5px] transition-colors ${tintClass}`}
            style={{
              width: cell,
              height: cell,
              animation: reduce ? "none" : "z-matrix 750ms linear infinite",
              animationDelay: `${diag * -150}ms`,
            }}
          />
        );
      })}
    </span>
  );
}

/** The 36px header bar every board pane wears. */
export function PaneHeader({
  label,
  detail,
  children,
  className = "",
}: {
  label: string;
  detail?: string | null;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex h-9 shrink-0 items-center justify-between border-b border-content/10 pr-2 pl-4 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
          {label}
        </span>
        {detail ? (
          <span className="truncate text-[11px] tabular-nums text-content/40">{detail}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function Spinner({ className = "size-3" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 motion-safe:animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  );
}
