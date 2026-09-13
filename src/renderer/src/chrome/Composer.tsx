import { Plus } from './icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, SPRING_SWAP } from '../lib/ease'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import {
  attachmentsFromFiles,
  filesFromClipboard,
  mergeAttachments,
  pickAttachments,
  revokeAttachment
} from '../lib/attachments'
import type { ContextUsage } from '../lib/contextUsage'
import { loadProjectFiles, peekProjectFiles } from '../lib/fileIndex'
import { buildMentionIndex, fileMentionParts } from '../lib/fileMentions'
import {
  commandTextParts,
  matchCommands,
  rankFiles,
  rankThreads,
  triggerAt,
  type Trigger
} from '../lib/composerTriggers'
import type { ProjectFile } from '../lib/fs'
import { composeInboxMessage, type InboxComposerCard } from '../lib/githubTasks'
import type { HandoffComposerCard } from '../lib/handoff'
import { looksLikeProject, type RecentProject } from '../lib/recents'
import type { Attachment, HarnessId, RuntimeMode, ThreadGoal } from '../lib/session'
import { harnessSupportsAttachments } from '../lib/session'
import { AccessPicker } from './AccessPicker'
import { GoalControl } from './GoalControl'
import { CommandPopover, type AtMatch, type PopoverMatches } from './CommandPopover'
import { ComposerRunner } from './ComposerRunner'
import { ContextControl } from './ContextControl'
import { AttachmentChip, openAttachmentImages } from './AttachmentChip'
import { subscribeAppshots } from '../lib/appshots'
import { BranchPicker } from './BranchPicker'
import { CwdPicker } from './CwdPicker'
import { InboxMiniCard } from './InboxMiniCard'
import { NoteMiniCard } from './NoteMiniCard'
import { HandoffMiniCard } from './HandoffMiniCard'
import { ModelPicker } from './ModelPicker'
import { ModelSettings } from './ModelSettings'
import { projectName } from '../lib/paths'
import { consumeQuoteRequest, type QuoteRequest } from '../lib/quoteDraft'
import { useTabGroupLogos } from '../hooks/useTabGroupLogos'
import {
  COMPOSER_RUNNER_CHANGE_EVENT,
  loadComposerRunner,
  loadMidTurnDefault,
  loadNotesEnabled,
  subscribeMidTurnDefault,
  subscribeNotesEnabled
} from '../lib/settings'
import { ComposerAction } from './ComposerAction'
import { decideComposerAction, type ComposerIntent } from '../lib/composerAction'
import {
  ComposerInput,
  NO_TOKENS,
  sameTokens,
  type ComposerInputHandle,
  type ComposerToken
} from './ComposerInput'
import { saveComposerDraft, takeComposerDraft } from '../lib/composerDrafts'
import { Lightbox } from './Lightbox'
import {
  loadNotes,
  peekNotes,
  rankNoteFiles,
  notesAsProjectFiles,
  type Note,
  type NoteComposerCard
} from '../lib/notes'
import { resolveTabGroupLogo } from '../lib/tabGroups'
import { ThreadTypeChip } from './ThreadTypeChip'
import { useSlashCommands } from '../lib/tcserver/slashCommands'
import { readCopiedMessage } from '../lib/copyMessage'
import { useSessionMetasWhen } from '../lib/tcserver/store'
import { tune as tuneSession } from '../lib/tcserver/commands'
import type { ThreadType } from '../lib/tcserver/types'
import { useProjects } from '../lib/tcserver/workspaces'

type Props = {
  enabled?: boolean
  focused: boolean
  shell?: boolean
  harness: HarnessId
  model: string
  modelSettings?: Record<string, string>
  runtimeMode: RuntimeMode
  cwd?: string
  executionCwd: string
  /** The thread this composer feeds; `@` never offers it to itself. */
  sessionId?: string
  projectId?: string | null
  branch?: string
  recents?: RecentProject[]
  hideProjectPicker?: boolean
  context?: ContextUsage
  quoteRequest?: QuoteRequest
  initialDraft?: string
  inboxCard?: InboxComposerCard
  noteCard?: NoteComposerCard
  handoffCard?: HandoffComposerCard
  busy?: boolean
  /** The turn is paused: Enter queues and the row waits for Continue. */
  paused?: boolean
  /** The thread's standing goal, edited from the bottom bar. */
  goal?: ThreadGoal | null
  hotkeys?: boolean
  onFocus: () => void
  onCwdChange: (cwd: string) => void
  onBranchChange?: () => void
  onNewTerminal?: () => void
  onModelChange: (harness: HarnessId, model: string) => void
  onModelSettingsChange?: (settings: Record<string, string>) => void
  onRuntimeModeChange: (mode: RuntimeMode) => void
  onQuoteRequestConsumed?: (id: number) => void
  onInboxCardDismiss?: () => void
  onNoteCardDismiss?: () => void
  onHandoffCardDismiss?: () => void
  onSubmit: (text: string, attachments: Attachment[], intent: ComposerIntent) => void
  /** The one button's Pause face, shown when the box is empty mid-turn. */
  onPause?: () => void
  /** Rides on the box's top edge (the implementation board's pass banner). */
  topSlot?: ReactNode
  /** What kind of thread this is; absent hides the chip (subagent children). */
  threadType?: ThreadType | null
  onThreadTypeChange?: (type: ThreadType) => void
  children?: ReactNode
}

function ToolButton({
  active,
  disabled,
  label,
  onClick,
  children
}: {
  active?: boolean
  disabled?: boolean
  label: string
  onClick?: () => void
  children: ReactNode
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
          ? 'bg-content/20 text-content'
          : 'bg-content/10 text-content/50 hover:bg-content/15 hover:text-content'
      } disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/50`}
    >
      {children}
    </button>
  )
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
  cwd = '~',
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
  children
}: Props) {
  const inputRef = useRef<ComposerInputHandle>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const attachmentsRef = useRef<Attachment[]>([])
  /** Where the caret sits in the serialized text, and the spans chips own. */
  const caretRef = useRef(0)
  const chipsRef = useRef<Array<[number, number]>>([])
  const consumedQuoteId = useRef<number | null>(null)
  /** The serialized text as last reported. A ref: typing must not render
   *  the composer; the token paint below is the only thing that reads it. */
  const draftRef = useRef(initialDraft ?? '')
  const [hasValue, setHasValue] = useState(
    () => (initialDraft ?? '').trim().length > 0 || !!inboxCard || !!noteCard || !!handoffCard
  )
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [fileDrag, setFileDrag] = useState(false)
  const reduce = useReducedMotion()
  const midTurnDefault = useSyncExternalStore(subscribeMidTurnDefault, loadMidTurnDefault)
  const intent = decideComposerAction({
    busy,
    paused,
    hasText: hasValue,
    invert: false,
    midTurnDefault
  })
  // The `/` or `@` token under the caret; Escape parks its key in
  // `dismissed` until the next edit. The active row is keyed by mode and
  // query so a keystroke resets it to the top without an effect.
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ key: string; index: number }>({
    key: '',
    index: 0
  })
  const [files, setFiles] = useState<ProjectFile[]>(() => peekProjectFiles(executionCwd) ?? [])
  const notesEnabled = useSyncExternalStore(subscribeNotesEnabled, loadNotesEnabled, () => true)
  const [notes, setNotes] = useState<Note[]>(() => peekNotes() ?? [])
  const [runnerEnabled, setRunnerEnabled] = useState(loadComposerRunner)
  const [runnerLive, setRunnerLive] = useState(() => busy && loadComposerRunner())
  const groupLogos = useTabGroupLogos()
  const projectLogoPath = resolveTabGroupLogo(projectName(cwd), groupLogos)

  attachmentsRef.current = attachments

  const live = trigger && dismissed !== `${trigger.mode}:${trigger.start}` ? trigger : null
  const commandOpen = live?.mode === 'command'
  const mentionOpen = live?.mode === 'file'
  const commands = useSlashCommands(harness, executionCwd, commandOpen)
  const metas = useSessionMetasWhen(!!live)
  const projects = useProjects()
  const attachmentsSupported = harnessSupportsAttachments(harness)
  const commandsByName = useMemo(
    () => new Map(commands.map((c) => [c.name, c] as const)),
    [commands]
  )
  const mentionFiles = useMemo(
    () => (notesEnabled ? [...files, ...notesAsProjectFiles(notes)] : files),
    [files, notes, notesEnabled]
  )
  const mentionIndex = useMemo(() => buildMentionIndex(mentionFiles), [mentionFiles])
  // Plain `/skill` and `@file` runs get their colour; connector tokens are
  // chips already, so their command parts are skipped.
  const tokensFor = useCallback(
    (text: string): ComposerToken[] => {
      const out: ComposerToken[] = []
      let offset = 0
      for (const part of commandTextParts(text, commandsByName)) {
        if (part.command) {
          if (part.command.source !== 'plugin' && part.command.source !== 'mcp') {
            out.push({ start: offset, end: offset + part.text.length, kind: 'skill' })
          }
        } else {
          let inner = offset
          for (const run of fileMentionParts(part.text, mentionIndex.labels)) {
            if (run.file) out.push({ start: inner, end: inner + run.text.length, kind: 'mention' })
            inner += run.text.length
          }
        }
        offset += part.text.length
      }
      return out.length === 0 ? NO_TOKENS : out
    },
    [commandsByName, mentionIndex]
  )
  // The paint runs once per frame, not per keystroke, and renders only when
  // a token actually moved — plain typing leaves the composer alone.
  const [tokens, setTokens] = useState<ComposerToken[]>(NO_TOKENS)
  const repaintFrame = useRef<number | null>(null)
  const scheduleRepaint = useCallback(() => {
    if (repaintFrame.current !== null) return
    repaintFrame.current = requestAnimationFrame(() => {
      repaintFrame.current = null
      const next = tokensFor(draftRef.current)
      setTokens((prev) => (sameTokens(prev, next) ? prev : next))
    })
  }, [tokensFor])
  useEffect(() => {
    scheduleRepaint()
    return () => {
      if (repaintFrame.current !== null) cancelAnimationFrame(repaintFrame.current)
      repaintFrame.current = null
    }
  }, [scheduleRepaint])
  // `@path` has to end on whitespace, so files with spaces cannot be mentioned.
  const mentionable = useMemo(
    () => files.filter((file) => !file.isDir && !/\s/.test(file.relative)),
    [files]
  )
  const matches = useMemo<PopoverMatches | null>(() => {
    if (!live) return null
    if (live.mode === 'command') {
      return { mode: 'command', rows: matchCommands(commands, live.query) }
    }
    const fileHits: AtMatch[] = looksLikeProject(executionCwd)
      ? rankFiles(mentionable, live.query).map((file) => ({ kind: 'file', file }))
      : []
    const threadHits: AtMatch[] = rankThreads(metas, live.query, sessionId, projectId).map(
      (session) => ({ kind: 'thread', session })
    )
    const noteHits: AtMatch[] = notesEnabled
      ? rankNoteFiles(notes, live.query).map((file) => ({ kind: 'note', file }))
      : []
    return { mode: 'file', rows: [...fileHits, ...threadHits, ...noteHits] }
  }, [commands, executionCwd, live, mentionable, metas, notes, notesEnabled, projectId, sessionId])
  const rows = matches?.rows.length ?? 0
  const selectionKey = live ? `${live.mode}:${live.query}` : ''
  const active =
    selection.key === selectionKey ? Math.min(selection.index, Math.max(0, rows - 1)) : 0
  const setActive = (index: number) => setSelection({ key: selectionKey, index })

  /** Fast and 1M reach a live thread at once through session.tune; the
   *  rest (effort) rides on the next send. Drafts have nothing to tune yet. */
  const changeModelSettings = (next: Record<string, string>) => {
    onModelSettingsChange?.(next)
    if (!sessionId) return
    const patch: { fast?: boolean; context1m?: boolean } = {}
    if (next.fast != null && next.fast !== modelSettings.fast) patch.fast = next.fast === 'true'
    if (next.context != null && next.context !== modelSettings.context) {
      patch.context1m = next.context === '1m'
    }
    if (Object.keys(patch).length > 0) void tuneSession(sessionId, patch).catch(() => undefined)
  }

  /** A model pick rebuilds the settings from the last-used ones (App owns
   *  that), so once they land, tell the live thread what Fast and 1M now
   *  are; otherwise the server keeps running the old tune behind the UI. */
  const retuneAfterPick = useRef(false)
  const changeModel = (nextHarness: HarnessId, nextModel: string) => {
    onModelChange(nextHarness, nextModel)
    retuneAfterPick.current = !!sessionId
  }
  useEffect(() => {
    if (!retuneAfterPick.current || !sessionId) return
    retuneAfterPick.current = false
    void tuneSession(sessionId, {
      fast: modelSettings.fast === 'true',
      context1m: modelSettings.context === '1m',
    }).catch(() => undefined)
  }, [model, modelSettings, sessionId])

  const syncHasValue = useCallback(
    (text: string, files: Attachment[]) => {
      setHasValue(
        text.trim().length > 0 || files.length > 0 || !!inboxCard || !!noteCard || !!handoffCard
      )
    },
    [inboxCard, noteCard, handoffCard]
  )

  useEffect(() => {
    syncHasValue(inputRef.current?.value() ?? '', attachmentsRef.current)
  }, [inboxCard, noteCard, handoffCard, syncHasValue])

  const addAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (!harnessSupportsAttachments(harness) || incoming.length === 0) return
      setAttachments((prev) => {
        const next = mergeAttachments(prev, incoming)
        syncHasValue(inputRef.current?.value() ?? '', next)
        return next
      })
      inputRef.current?.focus()
    },
    [harness, syncHasValue]
  )

  // Appshots routed to this session land here, whether they arrived
  // before or after the composer mounted.
  useEffect(() => {
    if (!sessionId) return;
    return subscribeAppshots(sessionId, addAttachments);
  }, [addAttachments, sessionId]);

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const removed = prev.find((file) => file.id === id)
        if (removed) revokeAttachment(removed)
        const next = prev.filter((file) => file.id !== id)
        syncHasValue(inputRef.current?.value() ?? '', next)
        return next
      })
      inputRef.current?.focus()
    },
    [syncHasValue]
  )

  useEffect(() => {
    if (harnessSupportsAttachments(harness)) return
    setAttachments((prev) => {
      if (prev.length === 0) return prev
      for (const file of prev) revokeAttachment(file)
      syncHasValue(inputRef.current?.value() ?? '', [])
      return []
    })
  }, [harness, syncHasValue])

  useEffect(() => {
    const refresh = () => setRunnerEnabled(loadComposerRunner())
    window.addEventListener(COMPOSER_RUNNER_CHANGE_EVENT, refresh)
    return () => window.removeEventListener(COMPOSER_RUNNER_CHANGE_EVENT, refresh)
  }, [])

  useEffect(() => {
    if (!runnerEnabled) {
      setRunnerLive(false)
      return
    }
    if (busy) setRunnerLive(true)
  }, [busy, runnerEnabled])

  useEffect(() => {
    let cancelled = false
    void loadProjectFiles(executionCwd, mentionOpen)
      .then((next) => {
        if (!cancelled) setFiles(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [executionCwd, mentionOpen])

  useEffect(() => {
    if (!mentionOpen || !notesEnabled) return
    let cancelled = false
    void loadNotes().then((next) => {
      if (!cancelled) setNotes(next)
    })
    return () => {
      cancelled = true
    }
  }, [mentionOpen, notesEnabled])

  /** Every input and caret move lands here; the trigger under the caret
   *  drives the popover, and a caret inside a chip never counts as typing. */
  const onInputState = useCallback(
    (text: string, caret: number, chips: Array<[number, number]>) => {
      caretRef.current = caret
      chipsRef.current = chips
      if (text !== draftRef.current) {
        draftRef.current = text
        scheduleRepaint()
      }
      syncHasValue(text, attachmentsRef.current)
      const next = triggerAt(text, caret)
      const covered = next ? chips.some(([a, b]) => next.start < b && caret > a) : false
      setTrigger((prev) => {
        const t = covered ? null : next
        if (!t || !prev) return t
        return prev.mode === t.mode && prev.start === t.start && prev.query === t.query ? prev : t
      })
    },
    [scheduleRepaint, syncHasValue]
  )

  // A thread's composer keeps what it held across pane changes; a fresh one
  // starts from the seed the shell hands it.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const saved = sessionId ? takeComposerDraft(sessionId) : undefined
    if (saved) {
      el.restore(saved.segments)
      if (saved.attachments.length) addAttachments(saved.attachments)
    } else if (initialDraft) {
      el.restore([{ text: initialDraft }])
    }
    return () => {
      // Attachments in a saved draft keep their preview URLs for the next
      // mount; anything else goes.
      if (sessionId) {
        saveComposerDraft(sessionId, {
          segments: el.snapshot(),
          attachments: attachmentsRef.current
        })
        return
      }
      for (const file of attachmentsRef.current) revokeAttachment(file)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, [sessionId])

  useEffect(() => {
    const el = inputRef.current
    if (!el || !quoteRequest) return

    const result = consumeQuoteRequest(el.value(), consumedQuoteId.current, quoteRequest)
    consumedQuoteId.current = result.consumedId
    if (result.changed) {
      // Chips are plain tokens in the quote text; the segments they were
      // survive by keeping them and only appending what the quote adds.
      const prefix = el.value()
      if (result.draft.startsWith(prefix)) {
        el.replaceRange(prefix.length, prefix.length, { text: result.draft.slice(prefix.length) })
      } else {
        el.restore([{ text: result.draft }])
      }
      setTrigger(null)
    }
    onQuoteRequestConsumed?.(quoteRequest.id)
  }, [onQuoteRequestConsumed, quoteRequest])

  /** Put the picked row into the text where the trigger was typed. Every
   *  kind rides as plain text: `/name` for commands (pi names its skills
   *  `skill:<name>`, so the token is `/skill:<name>`), `@path` for files
   *  and notes, `@thread:<id>` for threads. */
  const accept = (index: number) => {
    const el = inputRef.current
    if (!el || !live || !matches) return
    const caret = caretRef.current
    if (matches.mode === 'command') {
      const c = matches.rows[index]
      if (!c) return
      // Connectors become one chip that deletes as a unit; skills stay text.
      const insert =
        c.source === 'plugin' || c.source === 'mcp'
          ? { chip: { token: `/${c.name}`, name: c.name } }
          : { text: `/${c.name} ` }
      el.replaceRange(live.start, caret, insert)
    } else {
      const m = matches.rows[index]
      if (!m) return
      const inserted = m.kind === 'thread' ? `@thread:${m.session.id}` : `@${m.file.relative}`
      el.replaceRange(live.start, caret, { text: `${inserted} ` })
    }
    setTrigger(null)
  }

  useEffect(() => {
    if (!focused) return
    if (
      document.querySelector(
        '[data-model-picker], [data-access-picker], [data-model-settings], [data-file-picker], [data-branch-picker]'
      )
    )
      return
    inputRef.current?.focus()
  }, [focused])

  useEffect(() => {
    if (!enabled) {
      setFileDrag(false)
      return
    }
    const dropRoot = () => boxRef.current?.closest('[data-session-drop]') as HTMLElement | null

    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer
      if (!hasFiles(data)) return
      event.preventDefault()
      if (!attachmentsSupported) return
      data.dropEffect = 'copy'
      setFileDrag(true)
    }
    const onDragLeave = (event: DragEvent) => {
      const root = dropRoot()
      if (!root) return
      const next = event.relatedTarget as Node | null
      if (next && root.contains(next)) return
      setFileDrag(false)
    }
    const onDrop = (event: DragEvent) => {
      const data = event.dataTransfer
      if (!hasFiles(data)) return
      event.preventDefault()
      setFileDrag(false)
      if (!attachmentsSupported) return
      const files = [...data.files]
      if (files.length === 0) return
      void attachmentsFromFiles(files).then(addAttachments)
    }

    const root = dropRoot()
    root?.addEventListener('dragover', onDragOver)
    root?.addEventListener('dragleave', onDragLeave)
    root?.addEventListener('drop', onDrop)

    return () => {
      root?.removeEventListener('dragover', onDragOver)
      root?.removeEventListener('dragleave', onDragLeave)
      root?.removeEventListener('drop', onDrop)
    }
  }, [addAttachments, attachmentsSupported, enabled])

  const submit = (value: string, invert = false) => {
    const text = composeInboxMessage(inboxCard, value)
    const files = attachments
    if (!text && files.length === 0 && !noteCard && !handoffCard) return
    const intent = decideComposerAction({
      busy,
      paused,
      hasText: true,
      invert,
      midTurnDefault
    })
    onSubmit(text, files, intent === 'pause' ? 'send' : intent)
    inputRef.current?.clear()
    setAttachments([])
    setTrigger(null)
    syncHasValue('', [])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (live && rows > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((active + (e.key === 'ArrowDown' ? 1 : rows - 1)) % rows)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        accept(active)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(`${live.mode}:${live.start}`)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(inputRef.current?.value() ?? '', e.metaKey)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    // A prompt copied from a transcript carries its attachments in the
    // HTML flavour; pasting it back restores images, files and mentions.
    const copied = readCopiedMessage(e.clipboardData)
    if (copied) {
      e.preventDefault()
      if (copied.text) inputRef.current?.insertText(copied.text)
      if (copied.attachments.length) addAttachments(copied.attachments)
      return
    }
    const files = filesFromClipboard(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    if (!attachmentsSupported) return
    void attachmentsFromFiles(files).then(addAttachments)
  }

  // A pasted log or file's worth of text rides as a file, not as typed
  // text — a contenteditable holding 100 KB crawls on every keystroke.
  const attachLargePaste = useCallback(
    (file: File) => {
      void attachmentsFromFiles([file]).then(addAttachments)
    },
    [addAttachments]
  )

  const attachFromPicker = () => {
    if (!attachmentsSupported) return
    void pickAttachments().then((files) => {
      addAttachments(files)
      inputRef.current?.focus()
    })
  }

  return (
    <div
      data-composer
      className={`relative shrink-0 ${shell ? '' : 'p-1.5 pt-0'}`}
      onMouseDown={onFocus}
    >
      {children}
      <Lightbox />
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
            fileDrag ? 'border-accent/60' : 'border-content/10 has-focus:border-content/20'
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
                onClose={() => inputRef.current?.focus()}
              />
            )}
            <BranchPicker
              cwd={cwd}
              branch={branch}
              enabled={enabled && !busy}
              onChange={onBranchChange}
              onClose={() => inputRef.current?.focus()}
            />
            {threadType && onThreadTypeChange ? (
              <ThreadTypeChip
                value={threadType}
                onChange={onThreadTypeChange}
                onClose={() => inputRef.current?.focus()}
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
                    exit={
                      reduce ? undefined : { opacity: 0, scale: 0.9, transition: { duration: 0.1 } }
                    }
                  >
                    <AttachmentChip
                      attachment={file}
                      onRemove={() => removeAttachment(file.id)}
                      onOpen={
                        file.kind === 'image'
                          ? () => openAttachmentImages(attachments, file)
                          : undefined
                      }
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ) : null}

          {inboxCard ? <InboxMiniCard card={inboxCard} onDismiss={onInboxCardDismiss} /> : null}

          {noteCard ? <NoteMiniCard card={noteCard} onDismiss={onNoteCardDismiss} /> : null}

          {handoffCard ? (
            <HandoffMiniCard card={handoffCard} onDismiss={onHandoffCardDismiss} />
          ) : null}

          <ComposerInput
            ref={inputRef}
            placeholder={
              inboxCard
                ? 'Add a note, or send to start…'
                : noteCard
                  ? 'Add a message, or send…'
                  : handoffCard
                    ? 'Add context, or send to continue…'
                    : shell
                      ? 'How can I help you today?'
                      : 'Ask, build, / for skills, @ for references... '
            }
            className={`composer-field relative max-h-40 w-full px-3 font-sans text-sm leading-5.5 text-content outline-none ${
              shell ? 'py-4' : 'py-3'
            }`}
            maxHeight={160}
            tokens={tokens}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            attachLargePastes={attachmentsSupported ? attachLargePaste : undefined}
            onState={(text, caret, chips) => {
              if (text !== draftRef.current) setDismissed((prev) => (prev ? null : prev))
              onInputState(text, caret, chips)
            }}
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <ToolButton
              label={attachmentsSupported ? 'Attach files' : 'fx does not support attachments'}
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
                    '[data-model-picker], [data-access-picker], [data-model-settings], [data-thread-type-picker], [data-goal-control], [data-context-control]'
                  )
                ) {
                  return
                }
                const el = e.currentTarget
                if (el.scrollWidth <= el.clientWidth) return
                if (e.deltaX === 0 && e.deltaY !== 0) el.scrollLeft += e.deltaY
              }}
            >
              <div className="flex shrink-0 items-center gap-1">
                <ModelPicker
                  harness={harness}
                  model={model}
                  hotkeys={hotkeys && enabled}
                  onChange={changeModel}
                  onClose={() => inputRef.current?.focus()}
                />
                <ModelSettings
                  harness={harness}
                  model={model}
                  values={modelSettings}
                  onChange={changeModelSettings}
                  onClose={() => inputRef.current?.focus()}
                />
                {harness !== 'fx' ? (
                  <AccessPicker
                    value={runtimeMode}
                    onChange={onRuntimeModeChange}
                    onClose={() => inputRef.current?.focus()}
                  />
                ) : null}
                {sessionId ? (
                  <GoalControl
                    sessionId={sessionId}
                    goal={goal}
                    onClose={() => inputRef.current?.focus()}
                  />
                ) : null}
                {sessionId ? (
                  <ContextControl
                    sessionId={sessionId}
                    usage={context}
                    busy={busy}
                    onClose={() => inputRef.current?.focus()}
                  />
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <ComposerAction
                intent={intent}
                midTurnDefault={midTurnDefault}
                disabled={intent !== 'pause' && !hasValue}
                onSubmit={(invert) => submit(inputRef.current?.value() ?? '', invert)}
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
  )
}

function hasFiles(data: DataTransfer | null): data is DataTransfer {
  if (!data) return false
  return [...data.types].some((type) => type === 'Files' || type === 'application/x-moz-file')
}
