import { useEffect, useRef, type KeyboardEvent } from "react";
import { Button } from "../../../components/ui/button";
import { Kbd } from "../../../components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { ChevronLeft } from "../../../chrome/icons";
import type { OpenFileFn } from "../../../lib/search";
import type { Session } from "../../../lib/session";
import { useMetaById, useSessionById } from "../../../lib/threads/agents";
import { useSessionActions, useThreadChat, type SessionActions } from "../../threadChat";
import { SurfaceSkeleton } from "../../SurfaceSkeleton";
import { LoadLine } from "../../SessionPane";
import { useEnvironmentBlock } from "../../../chrome/ConnectionLine";
import { sessionStore } from "../../../lib/tcserver/store";
import { ThreadView } from "../ThreadView";

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
 * (inside it ⌘↩ is the composer's own). The header shows at once, titled
 * from the board's row until the meta lands; the body is the transcript's
 * skeleton until the thread's rows do.
 */

export function ChildPane({
  sessionId,
  environmentId,
  title,
  focusComposer,
  onBack,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
}: {
  sessionId: string;
  /** The host the thread runs on. */
  environmentId: string;
  /** The board row's title, shown until the thread's meta lands. */
  title?: string;
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

  // No rows yet and the host has not answered. A child the board knows only
  // from its meta has no `load` at all until useSessionById's fetch starts:
  // that is loading too, never an empty thread.
  const answered = session?.loaded === true || session?.load?.phase === "loaded";
  const loading = !meta || !session || (session.blocks.length === 0 && !answered);
  const block = useEnvironmentBlock(environmentId);

  // The composer mounts with the rows: until then the pane holds focus, so Escape still goes back.
  useEffect(() => {
    if (!focusComposer || loading) paneRef.current?.focus();
  }, [sessionId, focusComposer, loading]);

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !paneRef.current?.contains(e.target as Node)) return;
    const back = e.key === "Escape" || (e.key === "Enter" && e.metaKey && !(e.target as HTMLElement).closest?.("[data-composer-box]"));
    if (!back) return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  };

  // A thread of the same id on another host is not this one.
  if (meta && meta.environmentId !== environmentId) return null;

  return (
    <div ref={paneRef} tabIndex={-1} onKeyDown={onKey} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none" data-child-pane={sessionId} data-child-host={environmentId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-2">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="xs" onClick={onBack} />}>
            <ChevronLeft />
            Back
          </TooltipTrigger>
          <TooltipContent>
            Back to the board <Kbd size="sm">Esc</Kbd>
          </TooltipContent>
        </Tooltip>
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{meta?.title || title || "Untitled"}</span>
      </div>
      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col" data-transcript-loading={session?.load?.phase ?? "loading"}>
          {/* Slow or failed: SessionPane's one line, with Retry. */}
          {session?.load ? <LoadLine name={block.name} load={session.load} onRetry={() => sessionStore.retryLoad(sessionId)} /> : null}
          <div className="min-h-0 flex-1">
            <SurfaceSkeleton kind="transcript" label="Loading thread" />
          </div>
        </div>
      ) : (
        <ChildThread
          session={session}
          actions={actions}
          focusComposer={focusComposer}
          rootRef={paneRef}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onOpenSession={onOpenSession}
        />
      )}
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
