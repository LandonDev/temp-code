import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, ChevronLeft, Square } from "../../../chrome/icons";
import { respondHarnessApproval } from "../../../lib/harness/registry";
import type { OpenFileFn } from "../../../lib/search";
import * as commands from "../../../lib/tcserver/commands";
import { asHarness } from "../../../lib/tcserver/store";
import { isLiveStatus, useMetaById, useSessionById } from "../../../lib/threads/agents";
import { AgentTranscript } from "../../AgentTranscript";
import { ThreadView } from "../ThreadView";
import { typeWord } from "./useMasterModel";

/**
 * A child of the batch opened from the board (docs/LAYOUT.md "Master"):
 * the whole master view becomes the thread's own view, the one its type
 * would get as a tab (the implementation board, the plan document, the
 * fleet), over its transcript and a composer line that sends when it is
 * idle and steers while it runs. The header is one Back control to the
 * board; Escape and ⌘↩ anywhere in the view go back too.
 */

export function ChildPane({
  sessionId,
  focusComposer,
  onBack,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
}: {
  sessionId: string;
  /** Land in the composer on open (the row's Message action). */
  focusComposer: boolean;
  onBack: () => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const live = isLiveStatus(meta?.status);
  const inputRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusComposer) inputRef.current?.focus();
    else paneRef.current?.focus();
  }, [sessionId, focusComposer]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "Enter" && e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  if (!meta || !session) return null;
  const harness = asHarness(meta.provider);

  const chat: ReactNode = (
    <>
      <div className="relative min-h-0 flex-1">
        <AgentTranscript
          sessionId={sessionId}
          blocks={session.blocks}
          busy={!!session.busy}
          visible
          cwd={meta.cwd}
          harness={harness}
          onApproval={(requestId, decision) => respondHarnessApproval(harness, sessionId, requestId, decision)}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onSelectSession={onOpenSession}
        />
      </div>
      <ComposerLine inputRef={inputRef} session={session} live={live} />
    </>
  );

  return (
    <div ref={paneRef} tabIndex={-1} onKeyDown={onKey} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none" data-child-pane={sessionId}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-content/10 pr-3 pl-1.5">
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
      <ThreadView
        session={session}
        renderChat={() => chat}
        composing={false}
        onArmNewPass={() => {}}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

function ComposerLine({
  inputRef,
  session,
  live,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  session: NonNullable<ReturnType<typeof useSessionById>>;
  live: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      if (live) await commands.steer(session, body);
      else await commands.send(session, body);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };
  return (
    <form
      className="mx-3 mb-3 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-content/10 pr-1 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={live ? "Steer this thread…" : "Message this thread…"}
        aria-label="Message this thread"
        className="h-full min-w-0 flex-1 bg-transparent text-xs text-content outline-none placeholder:text-content/40"
      />
      {live ? (
        <button
          type="button"
          onClick={() => void commands.interrupt(session.id)}
          title="Stop"
          aria-label="Stop"
          className="pressable grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <Square className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
      <button
        type="submit"
        disabled={!text.trim() || sending}
        aria-label="Send"
        className="pressable grid size-6 shrink-0 place-items-center rounded-md bg-content text-background-base disabled:opacity-30"
      >
        <ArrowUp className="size-3" strokeWidth={2} />
      </button>
    </form>
  );
}
