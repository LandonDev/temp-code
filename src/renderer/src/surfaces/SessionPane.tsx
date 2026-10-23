import { GripVertical, X } from "../chrome/icons";
import type { OpenFileFn } from "../lib/search";
import { perfMark } from "../lib/perfMarks";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
} from "react";
import { useEnvironmentBlock } from "../chrome/ConnectionLine";
import { noteActiveSession } from "../lib/appshots";
import { useFirstPaintReport } from "../lib/firstPaint";
import { motion, useReducedMotion } from "motion/react";
import { ENTER } from "../lib/ease";
import { sessionStore } from "../lib/tcserver/store";
import { looksLikeProject, type RecentProject } from "../lib/recents";
import { sessionDisplayTitle, type LoadState, type Session } from "../lib/session";
import { diffChunk, threadViewsChunk } from "./chunks";
import { preloadWhenIdle } from "../lib/lazyChunk";
import { EmptySession } from "./EmptySession";
import { SurfaceSkeleton } from "./SurfaceSkeleton";
import { ThreadView } from "./threads/ThreadView";
import { useSessionActions, useThreadChat } from "./threadChat";
import * as serverCommands from "../lib/tcserver/commands";
import { askPreconnect, idleForPreconnect } from "../lib/preconnect";
import { MOD } from "../lib/platform";
import { ADD_TO_CHAT_EVENT, type AddToChatRequest } from "../lib/quoteDraft";

type Props = {
  session: Session;
  visible: boolean;
  focused: boolean;
  inSplit: boolean;
  composerFocused: boolean;
  recents: RecentProject[];
  hideProjectPicker?: boolean;
  onFocus: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onShowSourceControl?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
};

export const SessionPane = memo(function SessionPane({
  session,
  visible,
  focused,
  inSplit,
  composerFocused,
  recents,
  hideProjectPicker,
  onFocus,
  onClose,
  onOpenFile,
  onOpenDiff,
  onShowSourceControl,
  onOpenSession,
  onPaneDragStart,
}: Props) {
  const reduceMotion = useReducedMotion();
  const title = sessionDisplayTitle(session.title, session.harness);
  // App's handlers for every thread's chat, one route for the panes and
  // the views that mount a chat of their own (threadChat.tsx).
  const actions = useSessionActions();

  useLayoutEffect(() => {
    perfMark("pane-commit", session.id);
  }, [session.id]);

  // The first thread on screen warms, once the open has settled, the chunks
  // its chrome opens next: the changes pane and the other thread views.
  useEffect(() => {
    preloadWhenIdle(diffChunk);
    preloadWhenIdle(threadViewsChunk);
  }, []);

  // A thread is empty only when its host answered with no rows (a draft has
  // none by definition); until then the rows area is a skeleton (and a line
  // when it is slow or failed). Rows that fold to no blocks (a master woken
  // only by reports) still open the thread's own view.
  const loadPhase = session.load?.phase ?? "loaded";
  const isEmpty = session.blocks.length === 0 && loadPhase === "loaded" && session.load?.empty !== false;
  const waiting = session.blocks.length === 0 && loadPhase !== "loaded";
  // First rows later than half a second after the pane opened: one stall line.
  useFirstPaintReport(session.id, session.environmentId, session.blocks.length > 0);
  const retryLoad = useCallback(() => sessionStore.retryLoad(session.id), [session.id]);
  const showDeckProjectPicker = isEmpty && !looksLikeProject(session.cwd);
  const dockComposer = !isEmpty || inSplit;
  const rootRef = useRef<HTMLDivElement>(null);
  // The focused, visible pane is where an "automatic" appshot lands, and
  // the thread its host serves first (session.focus).
  useEffect(() => {
    if (!focused || !visible) return;
    noteActiveSession(session.id);
    serverCommands.focusSignal.pane(session.environmentId, session.id);
    return () => {
      noteActiveSession(null);
      serverCommands.focusSignal.left(session.id);
    };
  }, [focused, session.environmentId, session.id, visible]);

  // A click inside the pane that already owns focus and the composer asks
  // App for nothing; the action would be a no-op and the render a waste.
  const focusPane = useCallback(() => {
    if (focused && composerFocused) return;
    onFocus(session.id);
    // An idle thread whose composer is focused may get a turn: the host
    // opens its upstream socket now (held to one per account per minute
    // there; here one ask per thread per half minute keeps the chatter down).
    if (idleForPreconnect(session.status)) askPreconnect(session.id);
  }, [composerFocused, focused, onFocus, session.id, session.status]);
  // The thread's host, when it is not reachable: rows stay, sending waits.
  const block = useEnvironmentBlock(session.environmentId);
  const { composerOf, renderSlots, renderChat, newPassArmed, armNewPass, addSelectionToChat } = useThreadChat({
    session,
    actions,
    visible,
    focused,
    composerFocused,
    shell: !dockComposer,
    recents,
    hideProjectPicker: hideProjectPicker ? !showDeckProjectPicker : false,
    rootRef,
    onFocusPane: focusPane,
    onOpenFile,
    onOpenDiff,
    onOpenSession,
  });

  useEffect(() => {
    if (!focused) return;
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<AddToChatRequest>).detail;
      if (!detail?.text) return;
      addSelectionToChat(detail.text, detail.mode);
    };
    window.addEventListener(ADD_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TO_CHAT_EVENT, onAdd);
  }, [addSelectionToChat, focused]);

  // Keyed remount per session; the brief fade bridges the swap without
  // delaying it (no exit animation).
  return (
    <motion.div
      key={session.id}
      ref={rootRef}
      data-session-drop={session.id}
      initial={reduceMotion ? false : ENTER.initial}
      animate={ENTER.animate}
      transition={ENTER.transition}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={focusPane}
    >
      {inSplit ? (
        <div
          className={`flex h-9 shrink-0 touch-none items-center gap-1.5 border-b border-content/10 px-2 select-none ${
            onPaneDragStart ? "cursor-grab active:cursor-grabbing" : ""
          }`}
          onPointerDown={(event) => {
            if (event.button !== 0 || !onPaneDragStart) return;
            if (
              (event.target as HTMLElement | null)?.closest("[data-no-drag]")
            ) {
              return;
            }
            onPaneDragStart(event);
          }}
        >
          {onPaneDragStart ? (
            <GripVertical
              className="size-3.5 shrink-0 text-content/40"
              strokeWidth={1.75}
            />
          ) : null}
          <span
            className={`size-2 shrink-0 rounded-full ${focused ? "bg-accent" : "bg-transparent"}`}
          />
          <span
            className="min-w-0 flex-1 truncate text-xs text-content"
            title={title}
          >
            {title}
          </span>
          <button
            type="button"
            title={`Close Pane (${MOD}W)`}
            aria-label="Close pane"
            data-no-drag
            className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(session.id);
            }}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {isEmpty ? (
        <>
          <div className="relative min-h-0 flex-1">
            <EmptySession
              cwd={session.cwd}
              arcade={focused && visible}
              composer={dockComposer ? undefined : composerOf()}
              threadType={session.threadType ?? "chat"}
              onThreadTypeChange={
                session.parentId ? undefined : (type) => actions.onThreadTypeChange(session.id, type)
              }
            />
          </div>
          {dockComposer ? (
            <div className="mx-auto w-full max-w-4xl shrink-0">{composerOf()}</div>
          ) : null}
        </>
      ) : waiting ? (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col" data-transcript-loading={loadPhase}>
            {/* A host that is down already says so above the composer. */}
            {session.load && !block.degraded ? (
              <LoadLine name={block.name} load={session.load} onRetry={retryLoad} />
            ) : null}
            <div className="min-h-0 flex-1">
              <SurfaceSkeleton kind="transcript" label="Loading thread" />
            </div>
          </div>
          <div className="mx-auto w-full max-w-4xl shrink-0">{composerOf()}</div>
        </>
      ) : (
        <ThreadView
          session={session}
          renderChat={renderChat}
          renderSlots={renderSlots}
          composing={newPassArmed}
          onArmNewPass={armNewPass}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onShowSourceControl={onShowSourceControl}
          onOpenSession={onOpenSession}
        />
      )}
    </motion.div>
  );
});

/** The pane's one line while a transcript is slow or failed; null otherwise. */
export function loadLineText(name: string, load: LoadState, now: number): string | null {
  if (load.phase === "slow") return `Waiting for ${name} · ${Math.max(0, Math.floor((now - load.since) / 1000))} s`;
  if (load.phase !== "failed") return null;
  const host = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const why = load.error ? ` (${load.error})` : "";
  // No retry scheduled: the host answered with a refusal, not silence.
  if (load.retryAt === undefined) return `${host} could not open this thread${why}`;
  const wait = Math.ceil((load.retryAt - now) / 1000);
  return wait > 0 ? `${host} did not answer${why} · retrying in ${wait} s` : `${host} did not answer${why} · retrying…`;
}

function LoadLine({ name, load, onRetry }: { name: string; load: LoadState; onRetry: () => void }) {
  const ticking = load.phase === "slow" || load.phase === "failed";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ticking, load]);
  const text = loadLineText(name, load, now);
  if (!text) return null;
  return (
    <div
      role="status"
      data-load-line={load.phase}
      className="mx-auto mt-2 flex h-6 w-full max-w-4xl shrink-0 items-center gap-2 px-4 text-[11px] text-content/50"
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button type="button" onClick={onRetry} className="pressable shrink-0 rounded px-1.5 py-0.5 hover:bg-content/10 hover:text-content">
        {load.phase === "failed" ? "Retry now" : "Retry"}
      </button>
    </div>
  );
}
