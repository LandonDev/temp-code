import { useMemo, useRef, useState, type ReactNode } from "react";
import { mergeModelSettings, nativeModelId, resolveModel } from "../lib/models";
import type { HarnessId } from "../lib/session";
import * as serverCommands from "../lib/tcserver/commands";
import { sessionFromMeta, useSessionMetas } from "../lib/tcserver/store";
import type { SessionMeta } from "../lib/tcserver/types";
import { ChevronDown, CircleAlert, MessageSquare, Pause } from "./icons";
import { ModelPicker } from "./ModelPicker";
import { ModelSettings } from "./ModelSettings";
import { Popover } from "./Popover";

type Props = {
  /** Scopes the needs-you banner to one project; null shows every root.
   *  Paused and errored trees always span every workspace — Continue acts
   *  on a thread by id, so it needs no project of its own to run in. */
  projectId: string | null;
  /** The thread on screen: its own question rides the transcript, not a banner. */
  activeSessionId?: string;
  onOpen: (sessionId: string) => void;
};

type Kind = "recovery" | "paused" | "needs-you";

const GLOBAL_ROOT = (m: SessionMeta): boolean => !m.parentId && !m.archived;

const ROOT = (m: SessionMeta, projectId: string | null): boolean =>
  GLOBAL_ROOT(m) && (projectId === null || m.projectId === projectId);

export type BannerThreads = {
  paused: SessionMeta[];
  recovery: SessionMeta[];
  needsYou: SessionMeta[];
};

/**
 * Paused and recovery span every workspace — a resume or a continue acts on
 * a thread by id, so switching to its project first buys nothing. Needs-you
 * stays scoped to `projectId` (null for every root), and never counts the
 * thread already on screen: its own question rides the transcript.
 */
export function bannerThreads(
  metas: readonly SessionMeta[],
  projectId: string | null,
  activeSessionId: string | undefined,
): BannerThreads {
  const paused: SessionMeta[] = [];
  const recovery: SessionMeta[] = [];
  const needsYou: SessionMeta[] = [];
  for (const m of metas) {
    if (GLOBAL_ROOT(m)) {
      if (m.treeHasPaused) paused.push(m);
      if (m.treeCanContinue) recovery.push(m);
    }
    if (ROOT(m, projectId) && m.status === "waiting" && m.id !== activeSessionId) {
      needsYou.push(m);
    }
  }
  return { paused, recovery, needsYou };
}

/**
 * One line under the title bar per thread state the user must act on:
 * paused trees (Continue / Stop) and trees whose last turn failed (Continue)
 * across every workspace, plus threads waiting on an answer in the open
 * project that are not the one on screen (Open).
 */
export function ThreadBanners({ projectId, activeSessionId, onOpen }: Props) {
  const metas = useSessionMetas();
  // One pass per meta change, never per render: the lists feed the buttons below.
  const { paused, recovery, needsYou } = useMemo(
    () => bannerThreads(metas, projectId, activeSessionId),
    [activeSessionId, metas, projectId],
  );
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
  const continueErrored = (settings?: serverCommands.QueueRunSettings) =>
    run("recovery", () => each(recovery, (id) => serverCommands.continueSession(id, settings)));
  const continueLabel = recovery.length === 1 ? "Continue" : "Continue all";

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

const DESTRUCTIVE_BUTTON = "border-danger/25 bg-danger/10 hover:bg-danger/20";

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
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<{ harness: HarnessId; model: string }>({ harness: "claude", model: "" });
  const [settings, setSettings] = useState<Record<string, string>>({});

  const toggle = () => {
    if (!open) {
      const session = sessionFromMeta(from);
      setChoice({ harness: session.harness, model: session.model });
      setSettings(session.modelSettings);
    }
    setOpen(!open);
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
    <>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label="Continue on another model"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`-ml-px grid h-[22px] place-items-center rounded-l-none rounded-r-md border px-1 transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 ${DESTRUCTIVE_BUTTON}`}
      >
        <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <Popover
          anchor={trigger}
          side="bottom"
          align="end"
          width={300}
          autoFocus
          tabIndex={-1}
          role="dialog"
          aria-label="Continue as"
          ignore="[data-model-picker], [data-model-settings]"
          onDismiss={() => setOpen(false)}
        >
          <div className="px-3 pt-2.5 pb-3 text-content">
            <p className="text-[13px] font-medium">Continue as</p>
            <div className="mt-1.5 -ml-1 flex flex-wrap items-center gap-1">
              <ModelPicker
                harness={choice.harness}
                model={choice.model}
                onChange={(harness, model) => {
                  setChoice({ harness, model });
                  setSettings(mergeModelSettings(resolveModel(harness, model), settings));
                }}
              />
              <ModelSettings
                harness={choice.harness}
                model={choice.model}
                values={settings}
                onChange={setSettings}
              />
            </div>
            <button
              type="button"
              onClick={submit}
              className="pressable mt-2.5 flex h-8 w-full items-center justify-center rounded-lg bg-content text-[13px] font-medium text-background-base hover:bg-content/90"
            >
              {label}
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function Banner({
  kind,
  text,
  failed = 0,
  disabled = false,
  primary,
  secondary,
  menu,
}: {
  kind: Kind;
  text: string;
  failed?: number;
  disabled?: boolean;
  primary: Action;
  secondary?: Action;
  /** Split-button half beside the primary (a chevron and its popover). */
  menu?: ReactNode;
}) {
  const destructive = kind === "recovery";
  const Icon = kind === "paused" ? Pause : kind === "recovery" ? CircleAlert : MessageSquare;
  const tint = destructive
    ? "border-danger/20 bg-danger/8 text-danger"
    : "border-warning/20 bg-warning/8 text-warning";
  const button = destructive ? DESTRUCTIVE_BUTTON : "border-warning/25 bg-warning/10 hover:bg-warning/20";
  return (
    <div
      role={kind === "paused" ? "status" : "alert"}
      className={`flex min-h-7 items-center gap-2 border-b px-3 py-1 text-xs ${tint}`}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{text}</span>
      {failed > 0 ? <span className="shrink-0 text-current/70">· {failed} failed</span> : null}
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
        <span className="flex items-center">
          <button
            type="button"
            onClick={primary.onClick}
            disabled={disabled}
            className={`h-[22px] rounded-md border px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-60 ${menu ? "rounded-r-none" : ""} ${button}`}
          >
            {primary.label}
          </button>
          {menu}
        </span>
      </span>
    </div>
  );
}
