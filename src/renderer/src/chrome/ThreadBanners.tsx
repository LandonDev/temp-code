import { useMemo, useState, type ReactNode } from "react";
import { isStaleWatch } from "@shared/watch";
import { stopAll } from "../lib/activity";
import { heldSuffix, useMacHeldTotal } from "../lib/macBridge";
import { useSlowClock } from "../lib/turnClock";
import { duration } from "../lib/duration";
import { mergeModelSettings, nativeModelId, resolveModel } from "../lib/models";
import type { HarnessId } from "../lib/session";
import * as serverCommands from "../lib/tcserver/commands";
import { sessionFromMeta, useSessionMetas } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { stateLine } from "@shared/notes";
import { useThreadNotes } from "../lib/threadNotes";
import { Button } from "../components/ui/button";
import { StatusMark, type ThreadState } from "../components/ui/status";
import { cn } from "../lib/cn";
import { ChevronDown } from "./icons";
import { LazyPopover } from "./menuRows";
import { ModelPicker } from "./ModelPicker";

type Props = {
  /** Scopes the needs-you banner to one project; null shows every root.
   *  Paused and errored trees always span every workspace — Continue acts
   *  on a thread by id, so it needs no project of its own to run in. */
  projectId: string | null;
  /** The thread on screen: its own question rides the transcript, not a banner. */
  activeSessionId?: string;
  onOpen: (sessionId: string) => void;
};

type Kind = "recovery" | "paused" | "needs-you" | "watching";

const GLOBAL_ROOT = (m: SessionMeta): boolean => !m.parentId && !m.archived;

const ROOT = (m: SessionMeta, projectId: string | null): boolean =>
  GLOBAL_ROOT(m) && (projectId === null || m.projectId === projectId);

export type BannerThreads = {
  paused: SessionMeta[];
  /** batch threads paused with their master, folded out of `paused` */
  batchPaused: number;
  recovery: SessionMeta[];
  needsYou: SessionMeta[];
};

/**
 * Paused and recovery span every workspace — a resume or a continue acts on
 * a thread by id, so switching to its project first buys nothing. Needs-you
 * stays scoped to `projectId` (null for every root). The thread already on
 * screen is left out where it says the state itself: its strip offers Stop
 * and Continue, its question and its own failure ride the transcript.
 */
export function bannerThreads(
  metas: readonly SessionMeta[],
  projectId: string | null,
  activeSessionId: string | undefined,
): BannerThreads {
  const allPaused: SessionMeta[] = [];
  const recovery: SessionMeta[] = [];
  const needsYou: SessionMeta[] = [];
  for (const m of metas) {
    if (GLOBAL_ROOT(m)) {
      if (m.treeHasPaused) allPaused.push(m);
      // Its own failure's card carries Continue; a failed descendant's does not.
      if (m.treeCanContinue && !(m.id === activeSessionId && m.status === "error")) recovery.push(m);
    }
    if (ROOT(m, projectId) && m.status === "waiting" && m.id !== activeSessionId) {
      needsYou.push(m);
    }
  }
  // A batch thread paused with its master folds under the master's line.
  const pausedIds = new Set(allPaused.map((m) => m.id));
  const folded = (m: SessionMeta): boolean => !!m.masterId && pausedIds.has(m.masterId);
  const paused = allPaused.filter((m) => !folded(m) && m.id !== activeSessionId);
  const shownIds = new Set(paused.map((m) => m.id));
  const batchPaused = allPaused.filter((m) => folded(m) && shownIds.has(m.masterId!)).length;
  return { paused, recovery, needsYou, batchPaused };
}

/**
 * Roots in `projectId` (null: every root) watching for over 30 minutes
 * without waking (isStaleWatch), oldest first; the thread on screen is left
 * out, its own strip says it.
 */
export function staleWatchers(
  metas: readonly SessionMeta[],
  projectId: string | null,
  activeSessionId: string | undefined,
  now: number,
): SessionMeta[] {
  return metas
    .filter((m) => ROOT(m, projectId) && m.id !== activeSessionId && isStaleWatch(m, now))
    .sort((a, b) => (a.background?.watchingSince ?? 0) - (b.background?.watchingSince ?? 0));
}

/** A banner's subject and what it says about it. */
export type BannerLine = { subject: string; detail: string | null };

/** The stale-watching banner's line: the thread and how long it has watched (amber), or the count. */
export function staleText(stale: readonly Pick<SessionMeta, "title" | "background">[], now: number): BannerLine {
  if (stale.length !== 1) return { subject: `${stale.length} threads`, detail: "for over 30 min" };
  const since = stale[0].background?.watchingSince ?? now;
  return { subject: stale[0].title, detail: duration(Math.max(0, now - since)) };
}

/** The paused banner's line: the thread (or the count), the batch threads paused with their master, and the Mac jobs waiting with it when any. */
export function pausedText(paused: readonly Pick<SessionMeta, "title">[], held: number, batchPaused = 0): BannerLine {
  const subject = paused.length === 1 ? paused[0].title : `${paused.length} threads`;
  const batch = batchPaused > 0 ? `, and ${batchPaused} batch thread${batchPaused === 1 ? "" : "s"} with it` : "";
  return { subject, detail: `${batch}${heldSuffix(held)}`.replace(/^, /, "") || null };
}

/**
 * One row under the title bar per thread state the user must act on:
 * paused trees (Continue / Stop) and trees whose last turn failed (Continue)
 * across every workspace, threads waiting on an answer in the open project
 * that are not the one on screen (Open), and roots watching too long (Open,
 * Stop all). Each row leads with the state's mark and word, then the subject
 * and a muted detail; no wash, the mark carries the tone.
 */
export function ThreadBanners({ projectId, activeSessionId, onOpen }: Props) {
  const metas = useSessionMetas();
  // One pass per meta change, never per render: the lists feed the buttons below.
  const { paused, recovery, needsYou, batchPaused } = useMemo(
    () => bannerThreads(metas, projectId, activeSessionId),
    [activeSessionId, metas, projectId],
  );
  const [busy, setBusy] = useState<Kind | "stop" | null>(null);
  const [failed, setFailed] = useState<Record<Kind, number>>({ recovery: 0, paused: 0, "needs-you": 0, watching: 0 });
  // Mac calls the paused trees hold on their hosts (lib/macBridge.ts): they wait with the thread and resume with it.
  const pausedIds = useMemo(() => paused.map((m) => m.id), [paused]);
  const held = useMacHeldTotal(pausedIds);
  // The half-minute clock runs only while some root watches at all.
  const anyWatching = useMemo(() => metas.some((m) => GLOBAL_ROOT(m) && m.status === "watching"), [metas]);
  const now = useSlowClock(anyWatching);
  const stale = useMemo(
    () => (now ? staleWatchers(metas, projectId, activeSessionId, now) : []),
    [activeSessionId, metas, now, projectId],
  );

  if (paused.length === 0 && recovery.length === 0 && needsYou.length === 0 && stale.length === 0) return null;

  const run = async (kind: Kind | "stop", work: () => Promise<number>): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    const tally = kind === "stop" ? "paused" : kind;
    setFailed((prev) => ({ ...prev, [tally]: 0 }));
    try {
      const n = await work();
      setFailed((prev) => ({ ...prev, [tally]: n }));
    } catch {
      const total = kind === "recovery" ? recovery.length : kind === "watching" ? stale.length : paused.length;
      setFailed((prev) => ({ ...prev, [tally]: total }));
    } finally {
      setBusy(null);
    }
  };

  // Per thread, never the server-wide batch: the banner only lists this
  // project's roots, so only those may move.
  const each = async (list: SessionMeta[], work: (id: string) => Promise<unknown>) =>
    (await Promise.allSettled(list.map((m) => work(m.id)))).filter((r) => r.status === "rejected").length;
  const continuePaused = () => run("paused", () => each(paused, serverCommands.resume));
  const stopPaused = () => run("stop", () => each(paused, serverCommands.interrupt));
  const continueErrored = (settings?: serverCommands.QueueRunSettings) =>
    run("recovery", () => each(recovery, (id) => serverCommands.continueSession(id, settings)));
  const continueLabel = recovery.length === 1 ? "Continue" : "Continue all";
  const stopWatchers = () => run("watching", () => each(stale, stopAll));

  const several = (list: readonly SessionMeta[]): string => (list.length === 1 ? list[0].title : `${list.length} threads`);
  return (
    <section className="shrink-0" aria-label="Thread alerts" aria-live="polite">
      {needsYou.length === 1 ? (
        <NeedsYouBanner thread={needsYou[0]} onOpen={onOpen} />
      ) : needsYou.length > 1 ? (
        <Banner
          kind="needs-you"
          line={{ subject: several(needsYou), detail: null }}
          primary={{ label: "Open first", onClick: () => onOpen(needsYou[0].id) }}
        />
      ) : null}
      {recovery.length > 0 ? (
        <Banner
          kind="recovery"
          line={{ subject: several(recovery), detail: null }}
          failed={failed.recovery}
          disabled={busy !== null}
          primary={{
            label: busy === "recovery" ? "Continuing…" : continueLabel,
            onClick: () => void continueErrored(),
          }}
          menu={
            <ContinueAs
              from={recovery[0]}
              label={continueLabel}
              disabled={busy !== null}
              onContinue={(settings) => void continueErrored(settings)}
            />
          }
        />
      ) : null}
      {stale.length > 0 ? (
        <Banner
          kind="watching"
          line={staleText(stale, now)}
          amber={stale.length === 1}
          failed={failed.watching}
          disabled={busy !== null}
          secondary={{ label: busy === "watching" ? "Stopping…" : "Stop all", onClick: () => void stopWatchers() }}
          primary={{ label: "Open", onClick: () => onOpen(stale[0].id) }}
        />
      ) : null}
      {paused.length > 0 ? (
        <Banner
          kind="paused"
          line={pausedText(paused, held, batchPaused)}
          failed={failed.paused}
          disabled={busy !== null}
          secondary={{
            label: busy === "stop" ? "Stopping…" : paused.length === 1 ? "Stop" : "Stop all",
            onClick: () => void stopPaused(),
          }}
          primary={{
            label: busy === "paused" ? "Continuing…" : paused.length === 1 ? "Continue" : "Continue all",
            onClick: () => void continuePaused(),
          }}
        />
      ) : null}
    </section>
  );
}

type Action = { label: string; onClick: () => void };

/** One thread waiting on the person: its title, and the first line of its
 *  notes' State — what it was doing when it stopped to ask. */
function NeedsYouBanner({ thread, onOpen }: { thread: SessionMeta; onOpen: (sessionId: string) => void }) {
  const notes = useThreadNotes(thread.environmentId, thread.id);
  const state = notes ? stateLine(notes.text) : null;
  return (
    <Banner
      kind="needs-you"
      line={{ subject: thread.title, detail: state }}
      primary={{ label: "Open", onClick: () => onOpen(thread.id) }}
    />
  );
}

/** The split half of the error banner's Continue: restart every errored
 *  thread on another model or effort. Opens on the first thread's own. */
function ContinueAs({
  from,
  label,
  disabled,
  onContinue,
}: {
  from: SessionMeta;
  label: string;
  disabled: boolean;
  onContinue: (settings: serverCommands.QueueRunSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<{ harness: HarnessId; model: string }>({ harness: "claude", model: "" });
  const [settings, setSettings] = useState<Record<string, string>>({});

  const onOpenChange = (next: boolean) => {
    if (next) {
      const session = sessionFromMeta(from);
      setChoice({ harness: session.harness, model: session.model });
      setSettings(session.modelSettings);
    }
    setOpen(next);
  };
  const submit = () => {
    setOpen(false);
    onContinue({
      provider: choice.harness,
      model: nativeModelId(choice.model),
      reasoning: serverCommands.reasoningOf({ modelSettings: settings }),
    });
  };

  return (
    <LazyPopover
      trigger={
        <Button
          variant="secondary"
          size="icon-xs"
          disabled={disabled}
          aria-label="Continue on another model"
          className="rounded-l-none border-l border-border"
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      }
      open={open}
      onOpenChange={onOpenChange}
      side="bottom"
      align="end"
      label="Continue as"
      className="w-75 gap-0 px-3 pt-2.5 pb-3"
    >
      <p className="text-[13px] font-medium">Continue as</p>
      <div className="mt-1.5 -ml-1 flex flex-wrap items-center gap-1">
        <ModelPicker
          harness={choice.harness}
          model={choice.model}
          environmentId={from.environmentId}
          onChange={(harness, model) => {
            setChoice({ harness, model });
            setSettings(mergeModelSettings(resolveModel(harness, model, from.environmentId), settings));
          }}
          settings={{ values: settings, onChange: setSettings }}
        />
      </div>
      <Button className="mt-2.5 w-full" onClick={submit}>
        {label}
      </Button>
    </LazyPopover>
  );
}

const BANNER_STATE: Record<Kind, ThreadState> = {
  "needs-you": "waiting",
  recovery: "failed",
  paused: "paused",
  watching: "watching",
};

/** One 32px row under the title bar: the state's mark and word, the subject, a muted detail, the actions at the end. */
function Banner({
  kind,
  line,
  amber = false,
  failed = 0,
  disabled = false,
  primary,
  secondary,
  menu,
}: {
  kind: Kind;
  line: BannerLine;
  /** The detail is the person's problem (a watch gone stale). */
  amber?: boolean;
  failed?: number;
  disabled?: boolean;
  primary: Action;
  secondary?: Action;
  /** Split-button half beside the primary (a chevron and its popover). */
  menu?: ReactNode;
}) {
  return (
    <div
      role={kind === "paused" || kind === "watching" ? "status" : "alert"}
      className="flex h-8 items-center gap-2 border-b border-border px-3 text-xs"
    >
      <StatusMark state={BANNER_STATE[kind]} className="shrink-0" />
      <span className="min-w-0 truncate font-medium text-foreground">{line.subject}</span>
      {line.detail ? (
        <span className={cn("min-w-0 truncate", amber ? "text-warning tabular-nums" : "text-muted-foreground")}>{line.detail}</span>
      ) : null}
      {failed > 0 ? <span className="shrink-0 text-muted-foreground">{failed} failed</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {secondary ? (
          <Button variant="ghost" size="xs" onClick={secondary.onClick} disabled={disabled}>
            {secondary.label}
          </Button>
        ) : null}
        <span className="flex items-center">
          <Button
            variant="secondary"
            size="xs"
            onClick={primary.onClick}
            disabled={disabled}
            className={menu ? "rounded-r-none" : undefined}
          >
            {primary.label}
          </Button>
          {menu}
        </span>
      </span>
    </div>
  );
}
