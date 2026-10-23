import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronLeft } from "../../../chrome/icons";
import type { OpenFileFn } from "../../../lib/search";
import type { Session } from "../../../lib/session";
import { useMetaById, useSessionById } from "../../../lib/threads/agents";
import { useSessionActions, useThreadChat, type SessionActions } from "../../threadChat";
import { ThreadView } from "../ThreadView";
import { typeWord } from "./useMasterModel";

/**
 * A child of the batch opened from the board (docs/LAYOUT.md "Master"):
 * the whole master view becomes the thread's own view, the one its type
 * would get as a tab (the implementation board, the plan document, the
 * fleet), over its transcript, working strip and the same composer a tab
 * has (threadChat.tsx: model and reasoning, permission, attachments, `@`
 * and `/`, the queue, steer, the draft kept per thread). The thread lives
 * on `environmentId`, the master's host or another: the store holds every
 * host's rows by id, so the view, the transcript and every send reach that
 * host the way a rail row of another host opens. The header is one Back
 * control to the board; Escape and ⌘↩ outside the composer go back too
 * (inside it ⌘↩ is the composer's own).
 */

export function ChildPane({
  sessionId,
  environmentId,
  focusComposer,
  onBack,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
}: {
  sessionId: string;
  /** The host the thread runs on. */
  environmentId: string;
  /** Land in the composer on open (the row's Message action). */
  focusComposer: boolean;
  onBack: () => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const actions = useSessionActions();
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusComposer) paneRef.current?.focus();
  }, [sessionId, focusComposer]);

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !paneRef.current?.contains(e.target as Node)) return;
    const back = e.key === "Escape" || (e.key === "Enter" && e.metaKey && !(e.target as HTMLElement).closest?.("[data-composer-box]"));
    if (!back) return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  };

  if (!meta || !session || !actions || meta.environmentId !== environmentId) return null;

  return (
    <div ref={paneRef} tabIndex={-1} onKeyDown={onKey} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none" data-child-pane={sessionId} data-child-host={environmentId}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-content/10 pr-3 pl-1.5">
        <button
          type="button"
          onClick={onBack}
          title="Back to the board (Esc)"
          className="pressable inline-flex h-6 items-center gap-0.5 rounded-md pr-2 pl-1 text-xs text-content/60 hover:bg-content/5 hover:text-content"
        >
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          Back
        </button>
        <span className="min-w-0 truncate pl-1 text-[13px] font-medium text-content">{meta.title || "Untitled"}</span>
        <span className="shrink-0 text-xs text-content/40">{typeWord(meta)}</span>
      </div>
      <ChildThread
        session={session}
        actions={actions}
        focusComposer={focusComposer}
        rootRef={paneRef}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

/** The thread's own view over the chat a tab would build for it. */
function ChildThread({
  session,
  actions,
  focusComposer,
  rootRef,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
}: {
  session: Session;
  actions: SessionActions;
  focusComposer: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const chat = useThreadChat({
    session,
    actions,
    visible: true,
    // The master's own composer is not on screen while the child shows:
    // this one owns the model picker's shortcuts.
    focused: true,
    composerFocused: focusComposer,
    rootRef,
    onFocusPane: NOOP,
    onOpenFile,
    onOpenDiff,
    onOpenSession,
  });
  return (
    <ThreadView
      session={session}
      renderChat={chat.renderChat}
      renderSlots={chat.renderSlots}
      composing={chat.newPassArmed}
      onArmNewPass={chat.armNewPass}
      onOpenFile={onOpenFile}
      onOpenDiff={onOpenDiff}
      onOpenSession={onOpenSession}
    />
  );
}

const NOOP = () => {};
