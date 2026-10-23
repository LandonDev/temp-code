import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { AppshotFlyIn } from "../chrome/AppshotFlyIn";
import { Composer } from "../chrome/Composer";
import { ConnectionLine, useEnvironmentBlock } from "../chrome/ConnectionLine";
import { ChevronDown } from "../chrome/icons";
import { MacBridgeThreadCards } from "../chrome/MacBridgeCards";
import { MessageQueue } from "../chrome/MessageQueue";
import { SessionReview } from "../chrome/SessionReview";
import type { ComposerIntent } from "../lib/composerAction";
import { SPRING_PRESS, EASE_OUT } from "../lib/ease";
import type { ApprovalDecision } from "../lib/harness";
import { useMacBridgeRequests } from "../lib/macBridge";
import { createNote, noteTitle } from "../lib/notes";
import { acknowledgeQuoteRequest, type QuoteRequest } from "../lib/quoteDraft";
import type { RecentProject } from "../lib/recents";
import type { OpenFileFn } from "../lib/search";
import {
  sessionDisplayTitle,
  sessionWorkCwd,
  type Attachment,
  type Block,
  type HarnessId,
  type RuntimeMode,
  type Session,
} from "../lib/session";
import { loadNotesEnabled, subscribeNotesEnabled } from "../lib/settings";
import * as serverCommands from "../lib/tcserver/commands";
import { useQueue } from "../lib/tcserver/store";
import type { ThreadType } from "../lib/tcserver/types";
import { AgentTranscript } from "./AgentTranscript";
import { DeferredMount } from "./DeferredMount";
import { ChatColumn, type ChatOpts, type ChatSlots } from "./threads/chatSlots";
import { WorkingStrip } from "./threads/WorkingStrip";

/**
 * A thread's chat column, wherever it is drawn: the pane (SessionPane), a
 * master board's child pane and its New pass dialog. Every send, model
 * pick and approval goes through App's handlers, which act on the store by
 * session id and so reach the thread's own host; App hands them down as
 * props to the panes and through `SessionActionsContext` to anything a
 * view mounts on its own.
 */

/** What a thread's chat asks App to do, keyed by session id. */
export type SessionActions = {
  onSubmit: (
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options?: { newPass?: boolean; intent?: ComposerIntent },
  ) => void;
  onStop: (sessionId: string) => void;
  onApproval: (sessionId: string, requestId: string | number, decision: ApprovalDecision) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onBranchChange: (sessionId: string) => void;
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void;
  onModelSettingsChange: (sessionId: string, settings: Record<string, string>) => void;
  onRuntimeModeChange: (sessionId: string, mode: RuntimeMode) => void;
  onThreadTypeChange: (sessionId: string, type: ThreadType) => void;
  onNewTerminal: (sessionId: string) => void;
  onInboxCardDismiss?: (sessionId: string) => void;
  onNoteCardDismiss?: (sessionId: string) => void;
  onHandoffCardDismiss?: (sessionId: string) => void;
  onSecondOpinion?: (sessionId: string, harness: HarnessId, turn: Block[], model: string) => void;
  onHandoff?: (sessionId: string, harness: HarnessId, turn: Block[], model: string) => void;
};

export const SessionActionsContext = createContext<SessionActions | null>(null);

/** App's handlers, for a view that mounts a thread's chat outside a pane. */
export function useSessionActions(): SessionActions | null {
  return useContext(SessionActionsContext);
}

type ThreadComposerProps = {
  session: Session;
  actions: SessionActions;
  /** The composer's drop zone and hotkeys listen only while shown. */
  visible: boolean;
  /** Takes the caret when it turns true. */
  focused: boolean;
  /** The model picker's window shortcuts; one composer on screen owns them. */
  hotkeys: boolean;
  /** The empty session's centred shell rather than the docked bar. */
  shell?: boolean;
  recents?: RecentProject[];
  hideProjectPicker?: boolean;
  quoteRequest?: QuoteRequest;
  onQuoteRequestConsumed?: (id: number) => void;
  topSlot?: ReactNode;
  /** The next send opens a new round on the implementation board. */
  newPass?: boolean;
  onFocus: () => void;
  onOpenDiff: (path?: string) => void;
  /** After the composer handed a message (or a pause) to the thread. */
  onSent?: () => void;
};

/** The composer of one thread with everything that rides on it: the Mac
 *  bridge's cards, the message queue, the host's connection line and the
 *  review strip. */
export function ThreadComposer({
  session,
  actions,
  visible,
  focused,
  hotkeys,
  shell = false,
  recents,
  hideProjectPicker = false,
  quoteRequest,
  onQuoteRequestConsumed,
  topSlot,
  newPass = false,
  onFocus,
  onOpenDiff,
  onSent,
}: ThreadComposerProps) {
  const workCwd = sessionWorkCwd(session);
  const block = useEnvironmentBlock(session.environmentId);
  const macRequests = useMacBridgeRequests(session.environmentId, session.id);
  const paused = session.status === "paused";
  const queue = useQueue(session.id);
  const id = session.id;
  const queueStrip =
    queue.length > 0 ? (
      <MessageQueue
        items={queue}
        sessionId={id}
        paused={paused}
        onSteer={(item) => void serverCommands.queueSteer(id, item).catch(() => undefined)}
        onRemove={(item) => void serverCommands.queueRemove(id, item).catch(() => undefined)}
        onUpdate={(item, text) => void serverCommands.queueUpdate(id, item, text).catch(() => undefined)}
        onReorder={(order) => void serverCommands.queueReorder(id, order).catch(() => undefined)}
      />
    ) : null;
  const submit = (text: string, attachments: Attachment[], intent: ComposerIntent) => {
    actions.onSubmit(id, text, attachments, { ...(newPass ? { newPass: true } : {}), intent });
    onSent?.();
  };
  return (
    <Composer
      enabled={visible}
      blocked={block.text}
      focused={focused}
      hotkeys={hotkeys}
      shell={shell}
      harness={session.harness}
      model={session.model}
      modelSettings={session.modelSettings}
      runtimeMode={session.runtimeMode}
      cwd={session.cwd}
      executionCwd={workCwd}
      sessionId={id}
      projectId={session.projectId ?? null}
      recents={recents}
      hideProjectPicker={hideProjectPicker}
      context={session.context}
      quoteRequest={quoteRequest}
      initialDraft={session.inboxCard || session.noteCard || session.handoffCard ? undefined : session.composerSeed}
      inboxCard={session.inboxCard}
      noteCard={session.noteCard}
      handoffCard={session.handoffCard}
      onQuoteRequestConsumed={onQuoteRequestConsumed}
      onInboxCardDismiss={() => actions.onInboxCardDismiss?.(id)}
      onNoteCardDismiss={() => actions.onNoteCardDismiss?.(id)}
      onHandoffCardDismiss={() => actions.onHandoffCardDismiss?.(id)}
      onFocus={onFocus}
      onCwdChange={(cwd) => actions.onCwdChange(id, cwd)}
      onBranchChange={() => actions.onBranchChange(id)}
      onNewTerminal={() => actions.onNewTerminal(id)}
      onModelChange={(harness, model) => actions.onModelChange(id, harness, model)}
      onModelSettingsChange={(settings) => actions.onModelSettingsChange(id, settings)}
      onRuntimeModeChange={(mode) => actions.onRuntimeModeChange(id, mode)}
      threadType={session.parentId ? null : (session.threadType ?? "chat")}
      onThreadTypeChange={(type) => actions.onThreadTypeChange(id, type)}
      onSubmit={submit}
      onPause={() => void serverCommands.pause(id).catch(() => undefined)}
      busy={!!session.busy}
      paused={paused}
      goal={session.goal}
      topSlot={
        topSlot || queueStrip || block.degraded || macRequests.length > 0 ? (
          <>
            {macRequests.length > 0 ? <MacBridgeThreadCards environmentId={session.environmentId} sessionId={id} /> : null}
            {topSlot}
            {queueStrip}
            {block.degraded ? <ConnectionLine environmentId={session.environmentId} /> : null}
          </>
        ) : undefined
      }
    >
      <SessionReview sessionId={id} cwd={workCwd} enabled={visible} busy={!!session.busy} onOpenDiff={onOpenDiff} />
    </Composer>
  );
}

type ThreadChatArgs = {
  session: Session;
  actions: SessionActions;
  visible: boolean;
  /** The pane holds the window's focus. */
  focused: boolean;
  /** The pane's composer holds it. */
  composerFocused: boolean;
  /** The centred empty-session shell rather than the docked bar. */
  shell?: boolean;
  recents?: RecentProject[];
  hideProjectPicker?: boolean;
  /** Where the composer's input is looked up when a new pass arms. */
  rootRef: RefObject<HTMLElement | null>;
  onFocusPane: () => void;
  onOpenFile: OpenFileFn;
  onOpenDiff: (path?: string) => void;
  onOpenSession?: (sessionId: string) => void;
};

export type ThreadChat = {
  composerOf: (opts?: ChatOpts) => ReactNode;
  renderSlots: (opts?: ChatOpts) => ChatSlots;
  renderChat: (opts?: ChatOpts) => ReactNode;
  /** "Start pass N+1" on the implementation board: the next send opens a new round. */
  newPassArmed: boolean;
  armNewPass: (armed: boolean) => void;
  /** A selection quoted into the composer ("Add to chat"). */
  addSelectionToChat: (text: string, mode?: QuoteRequest["mode"]) => void;
};

/** The transcript, the working strip and the composer of one thread, as
 *  the pane builds them; a view seats them through `renderSlots`. */
export function useThreadChat({
  session,
  actions,
  visible,
  focused,
  composerFocused,
  shell = false,
  recents,
  hideProjectPicker,
  rootRef,
  onFocusPane,
  onOpenFile,
  onOpenDiff,
  onOpenSession,
}: ThreadChatArgs): ThreadChat {
  const reduceMotion = useReducedMotion();
  const sessionId = session.id;
  const { onApproval, onSecondOpinion, onHandoff, onStop } = actions;
  const approve = useCallback(
    (requestId: string | number, decision: ApprovalDecision) => onApproval(sessionId, requestId, decision),
    [onApproval, sessionId],
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
  const notesEnabled = useSyncExternalStore(subscribeNotesEnabled, loadNotesEnabled, () => true);
  const saveNote = useCallback(
    (text: string) => {
      const sessionTitle = sessionDisplayTitle(session.title, session.harness);
      void createNote(session.environmentId, {
        title: sessionTitle && sessionTitle !== "New session" ? sessionTitle : noteTitle(text),
        body: text,
        sourceSessionId: session.id,
        sourceCwd: session.cwd,
      });
    },
    [session.environmentId, session.cwd, session.harness, session.id, session.title],
  );
  const workCwd = sessionWorkCwd(session);
  // Stable per session so the transcript's memoised turn list holds across
  // pane re-renders (a tab switch, a composer keystroke).
  const onTurnSecondOpinion = useMemo(
    () =>
      onSecondOpinion
        ? (harness: HarnessId, turn: Block[], model: string) => onSecondOpinion(sessionId, harness, turn, model)
        : undefined,
    [onSecondOpinion, sessionId],
  );
  const onTurnHandoff = useMemo(
    () => (onHandoff ? (harness: HarnessId, turn: Block[], model: string) => onHandoff(sessionId, harness, turn, model) : undefined),
    [onHandoff, sessionId],
  );
  const [newPassArmed, setNewPassArmed] = useState(false);
  const armNewPass = useCallback(
    (armed: boolean) => {
      setNewPassArmed(armed);
      if (armed) {
        requestAnimationFrame(() => {
          rootRef.current?.querySelector<HTMLElement>("[data-composer-box] [data-composer-input]")?.focus();
        });
      }
    },
    [rootRef],
  );
  const resume = useCallback(() => serverCommands.resume(sessionId).catch(() => undefined), [sessionId]);

  const composerOf = (opts?: ChatOpts) => (
    <>
      <AppshotFlyIn sessionId={sessionId} active={focused && visible} />
      <ThreadComposer
        session={session}
        actions={actions}
        visible={visible}
        focused={focused && composerFocused}
        hotkeys={focused}
        shell={shell}
        recents={recents}
        hideProjectPicker={hideProjectPicker}
        quoteRequest={quoteRequest}
        onQuoteRequestConsumed={acknowledgeQuote}
        topSlot={opts?.topSlot}
        newPass={newPassArmed}
        onFocus={onFocusPane}
        onOpenDiff={onOpenDiff}
        onSent={() => setNewPassArmed(false)}
      />
    </>
  );
  const renderSlots = (opts?: ChatOpts): ChatSlots => ({
    transcript: (
      <div className="relative min-h-0 flex-1">
        {/* The header and composer commit with the click; the transcript,
            the heavy render, mounts in the deferred pass behind them. */}
        <DeferredMount key={sessionId} markId={sessionId}>
          <AgentTranscript
            sessionId={sessionId}
            turn={session}
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
            onSecondOpinion={onTurnSecondOpinion}
            onHandoff={onTurnHandoff}
            onJumpToBottomChange={setShowJumpToBottom}
            onJumpToBottomReady={onJumpToBottomReady}
          />
        </DeferredMount>
        <AnimatePresence>
          {showJumpToBottom ? (
            <motion.div
              key="jump"
              className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1, transition: SPRING_PRESS }}
              exit={{ opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } }}
            >
              <button
                type="button"
                title="Jump to latest"
                aria-label="Jump to latest"
                data-jump-to-bottom
                onClick={() => jumpToBottomRef.current?.()}
                className="pressable pointer-events-auto grid size-6 place-items-center rounded-md border border-content/10 bg-content/10 text-content shadow-md glass-surface glass-surface--md hover:bg-content/20"
              >
                <ChevronDown className="size-3.5" strokeWidth={1.75} />
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    ),
    strip:
      session.threadType !== "orchestration" ? (
        <WorkingStrip
          session={session}
          onStop={() => onStop(sessionId)}
          onResume={resume}
          onStart={() => serverCommands.startNow(sessionId).catch(() => undefined)}
        />
      ) : null,
    composer: composerOf(opts),
  });
  const renderChat = (opts?: ChatOpts) => <ChatColumn slots={renderSlots(opts)} />;
  return { composerOf, renderSlots, renderChat, newPassArmed, armNewPass, addSelectionToChat };
}
