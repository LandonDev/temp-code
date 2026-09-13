import { useMemo, useState } from "react";
import * as serverCommands from "../lib/tcserver/commands";
import { useSessionMetas } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { CircleAlert, MessageSquare, Pause } from "./icons";

type Props = {
  /** Only this project's threads raise banners; null shows every root. */
  projectId: string | null;
  /** The thread on screen: its own question rides the transcript, not a banner. */
  activeSessionId?: string;
  onOpen: (sessionId: string) => void;
};

type Kind = "recovery" | "paused" | "needs-you";

const ROOT = (m: SessionMeta, projectId: string | null): boolean =>
  !m.parentId && !m.archived && (projectId === null || m.projectId === projectId);

/**
 * One line under the title bar per thread state the user must act on:
 * paused trees (Continue / Stop), trees whose last turn failed (Continue)
 * and threads waiting on an answer that are not the one on screen (Open).
 */
export function ThreadBanners({ projectId, activeSessionId, onOpen }: Props) {
  const metas = useSessionMetas();
  // One pass per meta change, never per render: the lists feed the buttons below.
  const { paused, recovery, needsYou } = useMemo(() => {
    const paused: SessionMeta[] = [];
    const recovery: SessionMeta[] = [];
    const needsYou: SessionMeta[] = [];
    for (const m of metas) {
      if (!ROOT(m, projectId)) continue;
      if (m.treeHasPaused) paused.push(m);
      if (m.treeCanContinue) recovery.push(m);
      if (m.status === "waiting" && m.id !== activeSessionId) needsYou.push(m);
    }
    return { paused, recovery, needsYou };
  }, [activeSessionId, metas, projectId]);
  const [busy, setBusy] = useState<Kind | "stop" | null>(null);
  const [failed, setFailed] = useState<Record<Kind, number>>({ recovery: 0, paused: 0, "needs-you": 0 });

  if (paused.length === 0 && recovery.length === 0 && needsYou.length === 0) return null;

  const run = async (kind: Kind | "stop", work: () => Promise<number>): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    const tally = kind === "stop" ? "paused" : kind;
    setFailed((prev) => ({ ...prev, [tally]: 0 }));
    try {
      const n = await work();
      setFailed((prev) => ({ ...prev, [tally]: n }));
    } catch {
      setFailed((prev) => ({ ...prev, [tally]: kind === "recovery" ? recovery.length : paused.length }));
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
  const continueErrored = () => run("recovery", () => each(recovery, serverCommands.continueSession));

  return (
    <section className="shrink-0" aria-label="Thread alerts" aria-live="polite">
      {needsYou.length > 0 ? (
        <Banner
          kind="needs-you"
          text={
            needsYou.length === 1
              ? `${needsYou[0].title} needs you`
              : `${needsYou.length} threads need you`
          }
          primary={{
            label: needsYou.length === 1 ? "Open" : "Open first",
            onClick: () => onOpen(needsYou[0].id),
          }}
        />
      ) : null}
      {recovery.length > 0 ? (
        <Banner
          kind="recovery"
          text={
            recovery.length === 1
              ? `${recovery[0].title} stopped on an error`
              : `${recovery.length} threads stopped on an error`
          }
          failed={failed.recovery}
          disabled={busy !== null}
          primary={{
            label: busy === "recovery" ? "Continuing…" : recovery.length === 1 ? "Continue" : "Continue all",
            onClick: () => void continueErrored(),
          }}
        />
      ) : null}
      {paused.length > 0 ? (
        <Banner
          kind="paused"
          text={paused.length === 1 ? `${paused[0].title} is paused` : `${paused.length} threads paused`}
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

function Banner({
  kind,
  text,
  failed = 0,
  disabled = false,
  primary,
  secondary,
}: {
  kind: Kind;
  text: string;
  failed?: number;
  disabled?: boolean;
  primary: Action;
  secondary?: Action;
}) {
  const destructive = kind === "recovery";
  const Icon = kind === "paused" ? Pause : kind === "recovery" ? CircleAlert : MessageSquare;
  const tint = destructive
    ? "border-danger/20 bg-danger/8 text-danger"
    : "border-warning/20 bg-warning/8 text-warning";
  const button = destructive
    ? "border-danger/25 bg-danger/10 hover:bg-danger/20"
    : "border-warning/25 bg-warning/10 hover:bg-warning/20";
  return (
    <div
      role={kind === "paused" ? "status" : "alert"}
      className={`flex min-h-7 items-center gap-2 border-b px-3 py-1 text-xs ${tint}`}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{text}</span>
      {failed > 0 ? <span className="shrink-0 text-current/75">· {failed} failed</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {secondary ? (
          <button
            type="button"
            onClick={secondary.onClick}
            disabled={disabled}
            className="rounded-md border border-danger/25 bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60"
          >
            {secondary.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={primary.onClick}
          disabled={disabled}
          className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 ${button}`}
        >
          {primary.label}
        </button>
      </span>
    </div>
  );
}
