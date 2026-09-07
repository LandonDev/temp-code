import { Plus, StickyNote } from "./icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT, SPRING_SWAP } from "../lib/ease";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  attachmentsFromFiles,
  filesFromClipboard,
  mergeAttachments,
  pickAttachments,
  revokeAttachment,
} from "../lib/attachments";
import type { ContextUsage } from "../lib/contextUsage";
import { loadProjectFiles, peekProjectFiles } from "../lib/fileIndex";
import { buildMentionIndex, fileMentionParts } from "../lib/fileMentions";
import {
  commandTextParts,
  matchCommands,
  rankFiles,
  rankThreads,
  replaceTrigger,
  triggerAt,
  type Trigger,
} from "../lib/composerTriggers";
import type { ProjectFile } from "../lib/fs";
import {
  composeInboxMessage,
  type InboxComposerCard,
} from "../lib/githubTasks";
import type { HandoffComposerCard } from "../lib/handoff";
import { looksLikeProject, type RecentProject } from "../lib/recents";
import type { Attachment, HarnessId, RuntimeMode, ThreadGoal } from "../lib/session";
import { harnessSupportsAttachments } from "../lib/session";
import { AccessPicker } from "./AccessPicker";
import { GoalControl } from "./GoalControl";
import { AddonMark } from "./AddonMark";
import { CommandPopover, type AtMatch, type PopoverMatches } from "./CommandPopover";
import { ComposerRunner } from "./ComposerRunner";
import { ContextControl } from "./ContextControl";
import { AttachmentChip } from "./AttachmentChip";
import { BranchPicker } from "./BranchPicker";
import { CwdPicker } from "./CwdPicker";
import { FileTypeIcon } from "./FileTypeIcon";
import { InboxMiniCard } from "./InboxMiniCard";
import { NoteMiniCard } from "./NoteMiniCard";
import { HandoffMiniCard } from "./HandoffMiniCard";
import { ModelPicker } from "./ModelPicker";
import { ModelSettings } from "./ModelSettings";
import { projectName } from "../lib/paths";
import { consumeQuoteRequest, type QuoteRequest } from "../lib/quoteDraft";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  COMPOSER_RUNNER_CHANGE_EVENT,
  loadComposerRunner,
  loadMidTurnDefault,
  loadNotesEnabled,
  subscribeMidTurnDefault,
  subscribeNotesEnabled,
} from "../lib/settings";
import { ComposerAction } from "./ComposerAction";
import { decideComposerAction, type ComposerIntent } from "../lib/composerAction";
import { morphTextareaHeight } from "../lib/composerHeight";
import {
  isNoteMentionPath,
  loadNotes,
  peekNotes,
  rankNoteFiles,
  notesAsProjectFiles,
  type Note,
  type NoteComposerCard,
} from "../lib/notes";
import { resolveTabGroupLogo } from "../lib/tabGroups";
import { ThreadTypeChip } from "./ThreadTypeChip";
import { useSlashCommands } from "../lib/tcserver/slashCommands";
import { readCopiedMessage } from "../lib/copyMessage";
import { useSessionMetas } from "../lib/tcserver/store";
import type { SlashCommand, ThreadType } from "../lib/tcserver/types";
import { useProjects } from "../lib/tcserver/workspaces";

type Props = {
  enabled?: boolean;
  focused: boolean;
  shell?: boolean;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  runtimeMode: RuntimeMode;
  cwd?: string;
  executionCwd: string;
  /** The thread this composer feeds; `@` never offers it to itself. */
  sessionId?: string;
  projectId?: string | null;
  branch?: string;
  recents?: RecentProject[];
  hideProjectPicker?: boolean;
  context?: ContextUsage;
  quoteRequest?: QuoteRequest;
  initialDraft?: string;
  inboxCard?: InboxComposerCard;
  noteCard?: NoteComposerCard;
  handoffCard?: HandoffComposerCard;
  busy?: boolean;
  /** The turn is paused: Enter queues and the row waits for Continue. */
  paused?: boolean;
  /** The thread's standing goal, edited from the bottom bar. */
  goal?: ThreadGoal | null;
  hotkeys?: boolean;
  onFocus: () => void;
  onCwdChange: (cwd: string) => void;
  onBranchChange?: () => void;
  onNewTerminal?: () => void;
  onModelChange: (harness: HarnessId, model: string) => void;
  onModelSettingsChange?: (settings: Record<string, string>) => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onQuoteRequestConsumed?: (id: number) => void;
  onInboxCardDismiss?: () => void;
  onNoteCardDismiss?: () => void;
  onHandoffCardDismiss?: () => void;
  onSubmit: (text: string, attachments: Attachment[], intent: ComposerIntent) => void;
  /** The one button's Pause face, shown when the box is empty mid-turn. */
  onPause?: () => void;
  /** Rides on the box's top edge (the implementation board's pass banner). */
  topSlot?: ReactNode;
  /** What kind of thread this is; absent hides the chip (subagent children). */
  threadType?: ThreadType | null;
  onThreadTypeChange?: (type: ThreadType) => void;
  children?: ReactNode;
};

function ToolButton({
  active,
  disabled,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
        active
          ? "bg-content/20 text-content"
          : "bg-content/10 text-content/50 hover:bg-content/15 hover:text-content"
      } disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/50`}
    >
      {children}
    </button>
  );
}

export function Composer({
  enabled = true,
  focused,
  hotkeys = false,
  shell = false,
  harness,
  model,
  modelSettings = {},
  runtimeMode,
  cwd = "~",
  executionCwd,
  sessionId,
  projectId = null,
  branch,
  recents = [],
  hideProjectPicker = false,
  context,
  quoteRequest,
  initialDraft,
  inboxCard,
  noteCard,
  handoffCard,
  busy = false,
  paused = false,
  goal = null,
  onFocus,
  onCwdChange,
  onBranchChange,
  onNewTerminal,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
  onQuoteRequestConsumed,
  onInboxCardDismiss,
  onNoteCardDismiss,
  onHandoffCardDismiss,
  onSubmit,
  onPause,
  topSlot,
  threadType,
  onThreadTypeChange,
  children,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const consumedQuoteId = useRef<number | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [hasValue, setHasValue] = useState(
    () =>
      (initialDraft ?? "").trim().length > 0 ||
      !!inboxCard ||
      !!noteCard ||
      !!handoffCard,
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileDrag, setFileDrag] = useState(false);
  const reduce = useReducedMotion();
  const midTurnDefault = useSyncExternalStore(
    subscribeMidTurnDefault,
    loadMidTurnDefault,
  );
  const intent = decideComposerAction({
    busy,
    paused,
    hasText: hasValue,
    invert: false,
    midTurnDefault,
  });
  // The `/` or `@` token under the caret; Escape parks its key in
  // `dismissed` until the next edit. The active row is keyed by mode and
  // query so a keystroke resets it to the top without an effect.
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ key: string; index: number }>({
    key: "",
    index: 0,
  });
  const [files, setFiles] = useState<ProjectFile[]>(
    () => peekProjectFiles(executionCwd) ?? [],
  );
  const notesEnabled = useSyncExternalStore(
    subscribeNotesEnabled,
    loadNotesEnabled,
    () => true,
  );
  const [notes, setNotes] = useState<Note[]>(() => peekNotes() ?? []);
  const [runnerEnabled, setRunnerEnabled] = useState(loadComposerRunner);
  const [runnerLive, setRunnerLive] = useState(
    () => busy && loadComposerRunner(),
  );
  const groupLogos = useTabGroupLogos();
  const projectLogoPath = resolveTabGroupLogo(projectName(cwd), groupLogos);

  attachmentsRef.current = attachments;

  const live =
    trigger && dismissed !== `${trigger.mode}:${trigger.start}` ? trigger : null;
  const commandOpen = live?.mode === "command";
  const mentionOpen = live?.mode === "file";
  const commands = useSlashCommands(harness, executionCwd, commandOpen);
  const metas = useSessionMetas();
  const projects = useProjects();
  const attachmentsSupported = harnessSupportsAttachments(harness);
  const commandsByName = useMemo(
    () => new Map(commands.map((c) => [c.name, c] as const)),
    [commands],
  );
  const mentionFiles = useMemo(
    () =>
      notesEnabled ? [...files, ...notesAsProjectFiles(notes)] : files,
    [files, notes, notesEnabled],
  );
  const mentionIndex = useMemo(
    () => buildMentionIndex(mentionFiles),
    [mentionFiles],
  );
  // `@path` has to end on whitespace, so files with spaces cannot be mentioned.
  const mentionable = useMemo(
    () => files.filter((file) => !file.isDir && !/\s/.test(file.relative)),
    [files],
  );
  const matches = useMemo<PopoverMatches | null>(() => {
    if (!live) return null;
    if (live.mode === "command") {
      return { mode: "command", rows: matchCommands(commands, live.query) };
    }
    const fileHits: AtMatch[] = looksLikeProject(executionCwd)
      ? rankFiles(mentionable, live.query).map((file) => ({ kind: "file", file }))
      : [];
    const threadHits: AtMatch[] = rankThreads(metas, live.query, sessionId, projectId).map(
      (session) => ({ kind: "thread", session }),
    );
    const noteHits: AtMatch[] = notesEnabled
      ? rankNoteFiles(notes, live.query).map((file) => ({ kind: "note", file }))
      : [];
    return { mode: "file", rows: [...fileHits, ...threadHits, ...noteHits] };
  }, [commands, executionCwd, live, mentionable, metas, notes, notesEnabled, projectId, sessionId]);
  const rows = matches?.rows.length ?? 0;
  const selectionKey = live ? `${live.mode}:${live.query}` : "";
  const active =
    selection.key === selectionKey ? Math.min(selection.index, Math.max(0, rows - 1)) : 0;
  const setActive = (index: number) => setSelection({ key: selectionKey, index });

  const syncHasValue = useCallback(
    (text: string, files: Attachment[]) => {
      setHasValue(
        text.trim().length > 0 ||
          files.length > 0 ||
          !!inboxCard ||
          !!noteCard ||
          !!handoffCard,
      );
    },
    [inboxCard, noteCard, handoffCard],
  );

  useEffect(() => {
    syncHasValue(ref.current?.value ?? "", attachmentsRef.current);
  }, [inboxCard, noteCard, handoffCard, syncHasValue]);

  const addAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (!harnessSupportsAttachments(harness) || incoming.length === 0) return;
      setAttachments((prev) => {
        const next = mergeAttachments(prev, incoming);
        syncHasValue(ref.current?.value ?? "", next);
        return next;
      });
      ref.current?.focus();
    },
    [harness, syncHasValue],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const removed = prev.find((file) => file.id === id);
        if (removed) revokeAttachment(removed);
        const next = prev.filter((file) => file.id !== id);
        syncHasValue(ref.current?.value ?? "", next);
        return next;
      });
      ref.current?.focus();
    },
    [syncHasValue],
  );

  useEffect(() => {
    return () => {
      for (const file of attachmentsRef.current) revokeAttachment(file);
    };
  }, []);

  useEffect(() => {
    if (harnessSupportsAttachments(harness)) return;
    setAttachments((prev) => {
      if (prev.length === 0) return prev;
      for (const file of prev) revokeAttachment(file);
      syncHasValue(ref.current?.value ?? "", []);
      return [];
    });
  }, [harness, syncHasValue]);

  useEffect(() => {
    const refresh = () => setRunnerEnabled(loadComposerRunner());
    window.addEventListener(COMPOSER_RUNNER_CHANGE_EVENT, refresh);
    return () =>
      window.removeEventListener(COMPOSER_RUNNER_CHANGE_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!runnerEnabled) {
      setRunnerLive(false);
      return;
    }
    if (busy) setRunnerLive(true);
  }, [busy, runnerEnabled]);

  useEffect(() => {
    let cancelled = false;
    void loadProjectFiles(executionCwd, mentionOpen)
      .then((next) => {
        if (!cancelled) setFiles(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [executionCwd, mentionOpen]);

  useEffect(() => {
    if (!mentionOpen || !notesEnabled) return;
    let cancelled = false;
    void loadNotes().then((next) => {
      if (!cancelled) setNotes(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, notesEnabled]);

  const resizeTextarea = (el: HTMLTextAreaElement) => {
    morphTextareaHeight(el, 160);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !initialDraft) return;
    el.value = initialDraft;
    resizeTextarea(el);
  }, [initialDraft]);

  const syncHighlightScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    highlight.scrollTop = e.currentTarget.scrollTop;
    highlight.scrollLeft = e.currentTarget.scrollLeft;
  };

  const syncTokensFromTextarea = (el: HTMLTextAreaElement) => {
    setTrigger(triggerAt(el.value, el.selectionStart ?? 0));
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !quoteRequest) return;

    const result = consumeQuoteRequest(
      el.value,
      consumedQuoteId.current,
      quoteRequest,
    );
    consumedQuoteId.current = result.consumedId;
    if (result.changed) {
      el.value = result.draft;
      resizeTextarea(el);
      setDraft(result.draft);
      syncHasValue(result.draft, attachmentsRef.current);
      setTrigger(null);
      el.setSelectionRange(result.draft.length, result.draft.length);
      el.focus();
    }
    onQuoteRequestConsumed?.(quoteRequest.id);
  }, [onQuoteRequestConsumed, quoteRequest, syncHasValue]);

  /** Put the picked row into the text where the trigger was typed. Every
   *  kind rides as plain text: `/name` for commands (pi names its skills
   *  `skill:<name>`, so the token is `/skill:<name>`), `@path` for files
   *  and notes, `@thread:<id>` for threads. */
  const accept = (index: number) => {
    const el = ref.current;
    if (!el || !live || !matches) return;
    let inserted: string | undefined;
    if (matches.mode === "command") {
      const c = matches.rows[index];
      if (c) inserted = `/${c.name}`;
    } else {
      const m = matches.rows[index];
      if (m) inserted = m.kind === "thread" ? `@thread:${m.session.id}` : `@${m.file.relative}`;
    }
    if (!inserted) return;
    const caret = el.selectionStart ?? el.value.length;
    const next = replaceTrigger(el.value, live, caret, inserted);
    el.value = next.text;
    resizeTextarea(el);
    el.setSelectionRange(next.caret, next.caret);
    setDraft(next.text);
    syncHasValue(next.text, attachmentsRef.current);
    setTrigger(null);
    el.focus();
  };

  useEffect(() => {
    if (!focused) return;
    if (
      document.querySelector(
        "[data-model-picker], [data-access-picker], [data-model-settings], [data-file-picker], [data-branch-picker]",
      )
    )
      return;
    ref.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (!enabled) {
      setFileDrag(false);
      return;
    }
    const dropRoot = () =>
      boxRef.current?.closest("[data-session-drop]") as HTMLElement | null;

    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!hasFiles(data)) return;
      event.preventDefault();
      if (!attachmentsSupported) return;
      data.dropEffect = "copy";
      setFileDrag(true);
    };
    const onDragLeave = (event: DragEvent) => {
      const root = dropRoot();
      if (!root) return;
      const next = event.relatedTarget as Node | null;
      if (next && root.contains(next)) return;
      setFileDrag(false);
    };
    const onDrop = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (!hasFiles(data)) return;
      event.preventDefault();
      setFileDrag(false);
      if (!attachmentsSupported) return;
      const files = [...data.files];
      if (files.length === 0) return;
      void attachmentsFromFiles(files).then(addAttachments);
    };

    const root = dropRoot();
    root?.addEventListener("dragover", onDragOver);
    root?.addEventListener("dragleave", onDragLeave);
    root?.addEventListener("drop", onDrop);

    return () => {
      root?.removeEventListener("dragover", onDragOver);
      root?.removeEventListener("dragleave", onDragLeave);
      root?.removeEventListener("drop", onDrop);
    };
  }, [addAttachments, attachmentsSupported, enabled]);

  const submit = (value: string, invert = false) => {
    const text = composeInboxMessage(inboxCard, value);
    const files = attachments;
    if (!text && files.length === 0 && !noteCard && !handoffCard) return;
    const intent = decideComposerAction({
      busy,
      paused,
      hasText: true,
      invert,
      midTurnDefault,
    });
    onSubmit(text, files, intent === "pause" ? "send" : intent);
    if (!ref.current) return;
    ref.current.value = "";
    ref.current.style.height = "auto";
    setDraft("");
    setAttachments([]);
    setTrigger(null);
    syncHasValue("", []);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (live && rows > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((active + (e.key === "ArrowDown" ? 1 : rows - 1)) % rows);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(`${live.mode}:${live.start}`);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.currentTarget.value, e.metaKey);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // A prompt copied from a transcript carries its attachments in the
    // HTML flavour; pasting it back restores images, files and mentions.
    const copied = readCopiedMessage(e.clipboardData);
    if (copied) {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const text = el.value.slice(0, start) + copied.text + el.value.slice(end);
      el.value = text;
      resizeTextarea(el);
      el.setSelectionRange(start + copied.text.length, start + copied.text.length);
      setDraft(text);
      syncHasValue(text, attachmentsRef.current);
      if (copied.attachments.length) addAttachments(copied.attachments);
      return;
    }
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    if (!attachmentsSupported) return;
    void attachmentsFromFiles(files).then(addAttachments);
  };

  const attachFromPicker = () => {
    if (!attachmentsSupported) return;
    void pickAttachments().then((files) => {
      addAttachments(files);
      ref.current?.focus();
    });
  };

  return (
    <div
      data-composer
      className={`relative shrink-0 ${shell ? "" : "p-1.5 pt-0"}`}
      onMouseDown={onFocus}
    >
      {children}
      <div className="relative overflow-visible">
        <CommandPopover
          matches={matches}
          active={active}
          projectId={projectId}
          projects={projects}
          onActive={setActive}
          onAccept={accept}
        />
        {topSlot}
        <div
          ref={boxRef}
          data-composer-box
          className={`relative z-10 rounded-lg border bg-content/3 ${
            fileDrag
              ? "border-accent/60"
              : "border-content/10 has-focus:border-content/20"
          }`}
        >
          <AnimatePresence>
            {fileDrag ? (
              <motion.div
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={{ duration: 0.12, ease: EASE_OUT }}
                className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-accent/8 text-[12px] text-content/70"
              >
                Drop files to attach
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="flex min-w-0 items-center gap-2.5 px-3 pt-2.5">
            {hideProjectPicker ? null : (
              <CwdPicker
                cwd={cwd}
                recents={recents}
                projectLogoPath={projectLogoPath}
                enabled={enabled}
                onCwdChange={onCwdChange}
                onNewTerminal={onNewTerminal}
                onClose={() => ref.current?.focus()}
              />
            )}
            <BranchPicker
              cwd={cwd}
              branch={branch}
              enabled={enabled && !busy}
              onChange={onBranchChange}
              onClose={() => ref.current?.focus()}
            />
            {threadType && onThreadTypeChange ? (
              <ThreadTypeChip
                value={threadType}
                onChange={onThreadTypeChange}
                onClose={() => ref.current?.focus()}
              />
            ) : null}
          </div>

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              <AnimatePresence initial={false}>
                {attachments.map((file) => (
                  <motion.div
                    key={file.id}
                    layout
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1, transition: SPRING_SWAP }}
                    exit={reduce ? undefined : { opacity: 0, scale: 0.9, transition: { duration: 0.1 } }}
                  >
                    <AttachmentChip
                      attachment={file}
                      onRemove={() => removeAttachment(file.id)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ) : null}

          {inboxCard ? (
            <InboxMiniCard card={inboxCard} onDismiss={onInboxCardDismiss} />
          ) : null}

          {noteCard ? (
            <NoteMiniCard card={noteCard} onDismiss={onNoteCardDismiss} />
          ) : null}

          {handoffCard ? (
            <HandoffMiniCard
              card={handoffCard}
              onDismiss={onHandoffCardDismiss}
            />
          ) : null}

          <div className="relative">
            <div
              ref={highlightRef}
              aria-hidden
              className={`composer-highlight pointer-events-none absolute inset-0 max-h-40 overflow-hidden whitespace-pre-wrap break-words px-3 text-sm leading-5.5 text-content font-sans ${
                shell ? "py-4" : "py-3"
              }`}
            >
              <ComposerHighlight
                text={draft}
                commands={commandsByName}
                mentions={mentionIndex.labels}
              />
            </div>
            <textarea
              ref={ref}
              rows={1}
              spellCheck={false}
              defaultValue={initialDraft}
              placeholder={
                inboxCard
                  ? "Add a note, or send to start…"
                  : noteCard
                    ? "Add a message, or send…"
                    : handoffCard
                      ? "Add context, or send to continue…"
                      : shell
                        ? "How can I help you today?"
                        : "Ask, build, / for skills, @ for references... "
              }
              className={`composer-field relative max-h-40 w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent px-3 text-sm leading-5.5 outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap font-sans ${
                shell ? "py-4" : "py-3"
              }`}
              onFocus={onFocus}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onScroll={syncHighlightScroll}
              onClick={(e) => syncTokensFromTextarea(e.currentTarget)}
              onKeyUp={(e) => syncTokensFromTextarea(e.currentTarget)}
              onSelect={(e) => syncTokensFromTextarea(e.currentTarget)}
              onInput={(e) => {
                const el = e.currentTarget;
                resizeTextarea(el);
                setDraft(el.value);
                syncHasValue(el.value, attachments);
                setDismissed(null);
                syncTokensFromTextarea(el);
              }}
            />
          </div>

          <div className="flex items-center gap-1 px-2 pb-2">
            <ToolButton
              label={
                attachmentsSupported
                  ? "Attach files"
                  : "fx does not support attachments"
              }
              disabled={!attachmentsSupported}
              onClick={attachFromPicker}
            >
              <Plus className="size-3.5" strokeWidth={1.5} />
            </ToolButton>
            <div
              className="composer-toolbar flex min-w-0 flex-1 items-center"
              onWheel={(e) => {
                if (
                  e.target instanceof Element &&
                  e.target.closest(
                    "[data-model-picker], [data-access-picker], [data-model-settings], [data-thread-type-picker], [data-goal-control], [data-context-control]",
                  )
                ) {
                  return;
                }
                const el = e.currentTarget;
                if (el.scrollWidth <= el.clientWidth) return;
                if (e.deltaX === 0 && e.deltaY !== 0) el.scrollLeft += e.deltaY;
              }}
            >
              <div className="flex shrink-0 items-center gap-1">
                <ModelPicker
                  harness={harness}
                  model={model}
                  hotkeys={hotkeys && enabled}
                  onChange={onModelChange}
                  onClose={() => ref.current?.focus()}
                />
                <ModelSettings
                  harness={harness}
                  model={model}
                  values={modelSettings}
                  onChange={(settings) => onModelSettingsChange?.(settings)}
                  onClose={() => ref.current?.focus()}
                />
                {harness !== "fx" ? (
                  <AccessPicker
                    value={runtimeMode}
                    onChange={onRuntimeModeChange}
                    onClose={() => ref.current?.focus()}
                  />
                ) : null}
                {sessionId ? (
                  <GoalControl
                    sessionId={sessionId}
                    goal={goal}
                    onClose={() => ref.current?.focus()}
                  />
                ) : null}
                {sessionId ? (
                  <ContextControl
                    sessionId={sessionId}
                    usage={context}
                    busy={busy}
                    onClose={() => ref.current?.focus()}
                  />
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ComposerAction
                intent={intent}
                midTurnDefault={midTurnDefault}
                disabled={intent !== "pause" && !hasValue}
                onSubmit={(invert) => submit(ref.current?.value ?? "", invert)}
                onPause={() => onPause?.()}
              />
            </div>
          </div>
        </div>
        {runnerLive && runnerEnabled ? (
          <ComposerRunner
            boxRef={boxRef}
            cwd={cwd}
            busy={busy}
            enabled={enabled}
            onExited={() => setRunnerLive(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function ComposerHighlight({
  text,
  commands,
  mentions,
}: {
  text: string;
  commands: ReadonlyMap<string, SlashCommand>;
  mentions: ReadonlyMap<string, ProjectFile>;
}) {
  const parts = commandTextParts(text, commands);
  return (
    <>
      {parts.map((part, index) =>
        part.command ? (
          part.command.source === "plugin" || part.command.source === "mcp" ? (
            // An addon token wears a chip. The glyphs keep their width so
            // the textarea underneath stays in lockstep; the brand mark
            // sits over the slash.
            <span
              key={index}
              className="rounded-[5px] bg-accent/20 font-medium text-content [box-decoration-break:clone]"
            >
              <span className="relative text-transparent">
                {"/"}
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                  <AddonMark command={part.command} size={11} colored={false} className="text-content" />
                </span>
              </span>
              {part.text.slice(1)}
            </span>
          ) : (
            <span key={index} className="text-skill">
              {part.text}
            </span>
          )
        ) : (
          // Skill tokens always end on whitespace, so each remaining run still
          // starts on a boundary `@mention` matching can rely on.
          <MentionRuns key={index} text={part.text} mentions={mentions} />
        ),
      )}
      {text.endsWith("\n") ? "\n" : null}
    </>
  );
}

function MentionRuns({
  text,
  mentions,
}: {
  text: string;
  mentions: ReadonlyMap<string, ProjectFile>;
}) {
  const parts = fileMentionParts(text, mentions);
  return (
    <>
      {parts.map((part, index) =>
        part.file ? (
          <span key={index} className="text-mention">
            {/* The `@` keeps its width so the textarea underneath stays in
                lockstep; the file icon sits on top of it. */}
            <span className="relative text-transparent">
              {"@"}
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                {part.file && isNoteMentionPath(part.file.path) ? (
                  <StickyNote className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <FileTypeIcon
                    name={part.file.name}
                    isDir={Boolean(part.file.isDir)}
                    size={13}
                  />
                )}
              </span>
            </span>
            {part.text.slice(1)}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function hasFiles(data: DataTransfer | null): data is DataTransfer {
  if (!data) return false;
  return [...data.types].some(
    (type) => type === "Files" || type === "application/x-moz-file",
  );
}
