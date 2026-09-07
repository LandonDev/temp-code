import { ChevronDown, GripVertical, X } from "../chrome/icons";
import type { OpenFileFn } from "../lib/search";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Composer } from "../chrome/Composer";
import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../lib/ease";
import { MessageQueue } from "../chrome/MessageQueue";
import type { ComposerIntent } from "../lib/composerAction";
import { useQueue } from "../lib/tcserver/store";
import { SessionReview } from "../chrome/SessionReview";
import type { ApprovalDecision } from "../lib/harness";
import { looksLikeProject, type RecentProject } from "../lib/recents";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Attachment,
  type Block,
  type HarnessId,
  type RuntimeMode,
  type Session,
} from "../lib/session";
import type { ThreadType } from "../lib/tcserver/types";
import { AgentTranscript } from "./AgentTranscript";
import { EmptySession } from "./EmptySession";
import { ThreadView, type ChatOpts } from "./threads/ThreadView";
import { WorkingStrip } from "./threads/WorkingStrip";
import * as serverCommands from "../lib/tcserver/commands";
import { MOD } from "../lib/platform";
import { acknowledgeQuoteRequest, ADD_TO_CHAT_EVENT, type AddToChatRequest, type QuoteRequest } from "../lib/quoteDraft";
import { createNote, noteTitle } from "../lib/notes";
import {
  loadNotesEnabled,
  subscribeNotesEnabled,
} from "../lib/settings";

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
  onCwdChange: (sessionId: string, cwd: string) => void;
  onBranchChange: (sessionId: string) => void;
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void;
  onModelSettingsChange: (
    sessionId: string,
    settings: Record<string, string>,
  ) => void;
  onRuntimeModeChange: (sessionId: string, mode: RuntimeMode) => void;
  onThreadTypeChange: (sessionId: string, type: ThreadType) => void;
  onSubmit: (
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options?: { newPass?: boolean; intent?: ComposerIntent },
  ) => void;
  onStop: (sessionId: string) => void;
  onInboxCardDismiss?: (sessionId: string) => void;
  onNoteCardDismiss?: (sessionId: string) => void;
  onHandoffCardDismiss?: (sessionId: string) => void;
  onApproval: (
    sessionId: string,
    requestId: string | number,
    decision: ApprovalDecision,
  ) => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onShowSourceControl?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onSecondOpinion?: (
    sessionId: string,
    harness: HarnessId,
    turn: Block[],
    model: string,
  ) => void;
  onHandoff?: (
    sessionId: string,
    harness: HarnessId,
    turn: Block[],
    model: string,
  ) => void;
  onNewTerminal: (sessionId: string) => void;
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
  onCwdChange,
  onBranchChange,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
  onThreadTypeChange,
  onSubmit,
  onStop,
  onInboxCardDismiss,
  onNoteCardDismiss,
  onHandoffCardDismiss,
  onApproval,
  onOpenFile,
  onOpenDiff,
  onShowSourceControl,
  onOpenSession,
  onSecondOpinion,
  onHandoff,
  onNewTerminal,
  onPaneDragStart,
}: Props) {
  const reduceMotion = useReducedMotion();
  const title = sessionDisplayTitle(session.title, session.harness);
  const approve = useCallback(
    (requestId: string | number, decision: ApprovalDecision) =>
      onApproval(session.id, requestId, decision),
    [onApproval, session.id],
  );
  const jumpToBottomRef = useRef<(() => void) | null>(null);
  const quoteRequestId = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [quoteRequest, setQuoteRequest] = useState<QuoteRequest>();
  const onJumpToBottomReady = useCallback((jump: () => void) => {
    jumpToBottomRef.current = jump;
  }, []);
  const addSelectionToChat = useCallback((text: string, mode?: QuoteRequest["mode"]) => {
    quoteRequestId.current += 1;
    setQuoteRequest({ id: quoteRequestId.current, text, mode });
  }, []);
  const acknowledgeQuote = useCallback((handledId: number) => {
    setQuoteRequest((current) => acknowledgeQuoteRequest(current, handledId));
  }, []);
  const notesEnabled = useSyncExternalStore(
    subscribeNotesEnabled,
    loadNotesEnabled,
    () => true,
  );
  const saveNote = useCallback(
    (text: string) => {
      const sessionTitle = sessionDisplayTitle(session.title, session.harness);
      void createNote({
        title:
          sessionTitle && sessionTitle !== "New session"
            ? sessionTitle
            : noteTitle(text),
        body: text,
        sourceSessionId: session.id,
        sourceCwd: session.cwd,
      });
    },
    [session.cwd, session.harness, session.id, session.title],
  );

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
  const workCwd = sessionWorkCwd(session);
  const isEmpty = session.blocks.length === 0;
  const showDeckProjectPicker = isEmpty && !looksLikeProject(session.cwd);
  const dockComposer = !isEmpty || inSplit;
  const rootRef = useRef<HTMLDivElement>(null);
  // "Start pass N+1" on the implementation board: the next send opens a new
  // round, and the board steps aside for the composer until it goes.
  const [newPassArmed, setNewPassArmed] = useState(false);
  const armNewPass = useCallback((armed: boolean) => {
    setNewPassArmed(armed);
    if (armed) {
      requestAnimationFrame(() => {
        rootRef.current?.querySelector<HTMLTextAreaElement>("[data-composer-box] textarea")?.focus();
      });
    }
  }, []);
  const submit = useCallback(
    (text: string, attachments: Attachment[], intent: ComposerIntent) => {
      onSubmit(session.id, text, attachments, {
        ...(newPassArmed ? { newPass: true } : {}),
        intent,
      });
      setNewPassArmed(false);
    },
    [newPassArmed, onSubmit, session.id],
  );
  const pause = useCallback(
    () => serverCommands.pause(session.id).catch(() => undefined),
    [session.id],
  );
  const paused = session.status === "paused";
  const queue = useQueue(session.id);
  const queueStrip =
    queue.length > 0 ? (
      <MessageQueue
        items={queue}
        paused={paused}
        onSteer={(id) => void serverCommands.queueSteer(session.id, id).catch(() => undefined)}
        onRemove={(id) => void serverCommands.queueRemove(session.id, id).catch(() => undefined)}
        onUpdate={(id, text) =>
          void serverCommands.queueUpdate(session.id, id, text).catch(() => undefined)
        }
        onReorder={(order) =>
          void serverCommands.queueReorder(session.id, order).catch(() => undefined)
        }
      />
    ) : null;
  const resume = useCallback(
    () => serverCommands.resume(session.id).catch(() => undefined),
    [session.id],
  );
  const composerOf = (opts?: ChatOpts) => (
    <Composer
      enabled={visible}
      focused={focused && composerFocused}
      hotkeys={focused}
      shell={!dockComposer}
      harness={session.harness}
      model={session.model}
      modelSettings={session.modelSettings}
      runtimeMode={session.runtimeMode}
      cwd={session.cwd}
      executionCwd={workCwd}
      sessionId={session.id}
      projectId={session.projectId ?? null}
      recents={recents}
      hideProjectPicker={hideProjectPicker ? !showDeckProjectPicker : false}
      context={session.context}
      quoteRequest={quoteRequest}
      initialDraft={
        session.inboxCard || session.noteCard || session.handoffCard
          ? undefined
          : session.composerSeed
      }
      inboxCard={session.inboxCard}
      noteCard={session.noteCard}
      handoffCard={session.handoffCard}
      onQuoteRequestConsumed={acknowledgeQuote}
      onInboxCardDismiss={() => onInboxCardDismiss?.(session.id)}
      onNoteCardDismiss={() => onNoteCardDismiss?.(session.id)}
      onHandoffCardDismiss={() => onHandoffCardDismiss?.(session.id)}
      onFocus={() => onFocus(session.id)}
      onCwdChange={(cwd) => onCwdChange(session.id, cwd)}
      onBranchChange={() => onBranchChange(session.id)}
      onNewTerminal={() => onNewTerminal(session.id)}
      onModelChange={(harness, model) =>
        onModelChange(session.id, harness, model)
      }
      onModelSettingsChange={(settings) =>
        onModelSettingsChange(session.id, settings)
      }
      onRuntimeModeChange={(mode) => onRuntimeModeChange(session.id, mode)}
      threadType={session.parentId ? null : (session.threadType ?? "chat")}
      onThreadTypeChange={(type) => onThreadTypeChange(session.id, type)}
      onSubmit={submit}
      onPause={pause}
      busy={!!session.busy}
      paused={paused}
      topSlot={
        opts?.topSlot || queueStrip ? (
          <>
            {opts?.topSlot}
            {queueStrip}
          </>
        ) : undefined
      }
    >
      <SessionReview
        sessionId={session.id}
        cwd={workCwd}
        enabled={visible}
        busy={!!session.busy}
        onOpenDiff={onOpenDiff}
      />
    </Composer>
  );
  const renderChat = (opts?: ChatOpts) => (
    <>
      <div className="relative min-h-0 flex-1">
        <AgentTranscript
          blocks={session.blocks}
          busy={!!session.busy}
          visible={visible}
          cwd={workCwd}
          harness={session.harness}
          onApproval={approve}
          onAddToChat={addSelectionToChat}
          onSaveNote={notesEnabled ? saveNote : undefined}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
          onSelectSession={onOpenSession}
          onSecondOpinion={
            onSecondOpinion
              ? (harness, turn, model) => onSecondOpinion(session.id, harness, turn, model)
              : undefined
          }
          onHandoff={
            onHandoff
              ? (harness, turn, model) => onHandoff(session.id, harness, turn, model)
              : undefined
          }
          onJumpToBottomChange={setShowJumpToBottom}
          onJumpToBottomReady={onJumpToBottomReady}
        />
        {showJumpToBottom ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
            <button
              type="button"
              title="Jump to latest"
              aria-label="Jump to latest"
              data-jump-to-bottom
              onClick={() => jumpToBottomRef.current?.()}
              className="pointer-events-auto grid size-6 place-items-center rounded-md border border-content/15 bg-content/10 text-content shadow-md backdrop-blur-md hover:bg-content/5"
            >
              <ChevronDown className="size-4" strokeWidth={2} />
            </button>
          </div>
        ) : null}
      </div>
      <div className="mx-auto w-full max-w-4xl shrink-0">
        {session.threadType !== "orchestration" ? (
          <WorkingStrip session={session} onStop={() => onStop(session.id)} onResume={resume} />
        ) : null}
        {composerOf(opts)}
      </div>
    </>
  );

  // Keyed remount per session; the brief fade bridges the swap without
  // delaying it (no exit animation).
  return (
    <motion.div
      key={session.id}
      ref={rootRef}
      data-session-drop={session.id}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: EASE_OUT }}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={() => onFocus(session.id)}
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
              className="size-3.5 shrink-0 text-content/35"
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
            className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(session.id);
            }}
          >
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      {isEmpty ? (
        <>
          <div className="relative min-h-0 flex-1">
            <EmptySession
              cwd={session.cwd}
              composer={dockComposer ? undefined : composerOf()}
              threadType={session.threadType ?? "chat"}
              onThreadTypeChange={
                session.parentId ? undefined : (type) => onThreadTypeChange(session.id, type)
              }
            />
          </div>
          {dockComposer ? (
            <div className="mx-auto w-full max-w-4xl shrink-0">{composerOf()}</div>
          ) : null}
        </>
      ) : (
        <ThreadView
          session={session}
          renderChat={renderChat}
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
