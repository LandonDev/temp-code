import { registry } from '../lib/connection'
import { environmentOfCwd, hostOfCwd } from '../lib/tcserver/projects'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { DUR, EASE_OUT } from '../lib/ease'
import { recordSendOrigin } from '../lib/sendOrigin'
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
  triggerInsert,
  type Trigger
} from '../lib/composerTriggers'
import type { ProjectFile } from '../lib/fs'
import { composeInboxMessage, type InboxComposerCard } from '../lib/githubTasks'
import type { HandoffComposerCard } from '../lib/handoff'
import { looksLikeProject, type RecentProject } from '../lib/recents'
import type { Attachment, HarnessId, RuntimeMode, ThreadGoal } from '../lib/session'
import { harnessSupportsAttachments } from '../lib/session'
import { GoalDialog } from './GoalDialog'
import { CommandPopover, type AtMatch, type PopoverMatches } from './CommandPopover'
import { ComposerRunner } from './ComposerRunner'
import { AttachmentChip, openAttachmentImages } from './AttachmentChip'
import {
  AttachmentUploadError,
  attachmentSettings,
  copiesBytes,
  needsUpload,
  overLimitMessage,
  uploadAttachments,
  type UploadProgress
} from '../lib/attachmentUpload'
import { subscribeAppshots } from '../lib/appshots'
import { BranchPicker } from './BranchPicker'
import { CwdPicker } from './CwdPicker'
import { DraftHostPicker } from './DraftHostPicker'
import { InboxMiniCard } from './InboxMiniCard'
import { NoteMiniCard } from './NoteMiniCard'
import { HandoffMiniCard } from './HandoffMiniCard'
import { ModelPicker } from './ModelPicker'
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
import { COMPOSER_SURFACE, ComposerBar, SendButton, useDraftRow } from './ComposerBar'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { X } from './icons'
import { decideComposerAction, type ComposerIntent } from '../lib/composerAction'
import {
  ComposerInput,
  NO_TOKENS,
  sameTokens,
  type ComposerInputHandle,
  type ComposerToken
} from './ComposerInput'
import { saveComposerDraft, takeComposerDraft } from '../lib/composerDrafts'
import { lightboxChunk } from '../surfaces/chunks'

// The image viewer rides its own chunk (surfaces/chunks.ts); a thumbnail's hover warms it.
const Lightbox = lightboxChunk.surface('Lightbox')
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
import { sessionStore, useSessionMeta, useSessionMetasWhen } from '../lib/tcserver/store'
import { threadToken } from '../lib/threadMentions'
import { tune as tuneSession } from '../lib/tcserver/commands'
import { nativeModelId } from '../lib/models'
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
  /** The thread's standing goal, edited in the goal dialog (the thread menu's Goal…). */
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
  /** Why a message cannot go right now (the thread's host is unreachable): shown in place of the placeholder, send waits. */
  blocked?: string | null
  /** What kind of thread this is; absent hides the chip (subagent children). */
  threadType?: ThreadType | null
  onThreadTypeChange?: (type: ThreadType) => void
  children?: ReactNode
}

export function Composer({
  enabled = true,
  blocked = null,
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
  /** Files on their way to the thread's host (lib/attachmentUpload.ts), by attachment id. */
  const [uploads, setUploads] = useState<Record<string, UploadProgress & { failed?: boolean }>>({})
  /** Why an attachment could not go (too big, an upload failed): shown here, never as a failed turn. */
  const [attachNote, setAttachNote] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const uploadingRef = useRef(false)
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
  const [notes, setNotes] = useState<Note[]>(() => peekNotes(hostOfCwd(executionCwd)) ?? [])
  const [runnerEnabled, setRunnerEnabled] = useState(loadComposerRunner)
  const [runnerLive, setRunnerLive] = useState(() => busy && loadComposerRunner())
  const groupLogos = useTabGroupLogos()
  const projectLogoPath = resolveTabGroupLogo(projectName(cwd), groupLogos)

  attachmentsRef.current = attachments

  const live = trigger && dismissed !== `${trigger.mode}:${trigger.start}` ? trigger : null
  const commandOpen = live?.mode === 'command'
  const mentionOpen = live?.mode === 'file'
  const metas = useSessionMetasWhen(!!live)
  const sessionMeta = useSessionMeta(sessionId)
  const draft = useDraftRow(sessionId, shell)
  const projects = useProjects()
  const environmentId = (sessionId ? sessionStore.environmentOf(sessionId) : undefined) ?? sessionMeta?.environmentId ?? projects.find((p) => p.id === projectId)?.environmentId ?? environmentOfCwd(executionCwd) ?? registry.primary().environmentId
  const commands = useSlashCommands(environmentId, harness, executionCwd, commandOpen)
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
    const patch: { fast?: boolean; ultrafast?: boolean; context1m?: boolean } = {}
    if (next.fast != null && next.fast !== modelSettings.fast) patch.fast = next.fast === 'true'
    if (next.ultrafast != null && next.ultrafast !== modelSettings.ultrafast) {
      patch.ultrafast = next.ultrafast === 'true'
    }
    if (next.context != null && next.context !== modelSettings.context) {
      patch.context1m = next.context === '1m'
    }
    if (Object.keys(patch).length > 0) void tuneSession(sessionId, patch).catch(() => undefined)
  }

  /** A model pick rebuilds the settings from the last-used ones (App owns
   *  that), so once they land, tell the live thread what Fast, 1M and the
   *  model now are; otherwise the server keeps running the old tune behind
   *  the UI. The model lands at once so the thread's account re-picks for
   *  it before any send; a pick of another provider's model waits for the
   *  send, which switches the harness. */
  const retuneAfterPick = useRef(false)
  const changeModel = (nextHarness: HarnessId, nextModel: string) => {
    onModelChange(nextHarness, nextModel)
    retuneAfterPick.current = !!sessionId
  }
  const threadProvider = sessionMeta?.provider
  useEffect(() => {
    if (!retuneAfterPick.current || !sessionId) return
    retuneAfterPick.current = false
    void tuneSession(sessionId, {
      fast: modelSettings.fast === 'true',
      ultrafast: modelSettings.ultrafast === 'true',
      context1m: modelSettings.context === '1m',
      ...(harness === threadProvider ? { model: nativeModelId(model) } : {}),
    }).catch(() => undefined)
  }, [model, modelSettings, sessionId, harness, threadProvider])

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

  // A file that is copied to the host (a paste, or a file from another
  // host) must fit the host's attachment.maxBytes; one over it is refused
  // here, with the reason, instead of failing at send.
  const admitAttachments = useCallback(
    (incoming: Attachment[]) => {
      if (incoming.length === 0) return
      void attachmentSettings(environmentId).then(({ maxBytes }) => {
        const over = incoming.filter((file) => copiesBytes(file, environmentId) && file.size > maxBytes)
        for (const file of over) revokeAttachment(file)
        setAttachNote(over.length ? over.map((file) => overLimitMessage(file, maxBytes)).join('. ') : null)
        addAttachments(incoming.filter((file) => !over.includes(file)))
      })
    },
    [addAttachments, environmentId]
  )
  const attachFailed = useCallback((error: unknown) => {
    setAttachNote(error instanceof Error ? error.message : 'Could not attach the file')
  }, [])

  const removeAttachment = useCallback(
    (id: string) => {
      setUploads((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
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

  // The index walks the tree; only an open `@` menu is worth that.
  useEffect(() => {
    if (!mentionOpen) return
    let cancelled = false
    void loadProjectFiles(executionCwd, true)
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
    void loadNotes(environmentId).then((next) => {
      if (!cancelled) setNotes(next)
    })
    return () => {
      cancelled = true
    }
  }, [environmentId, mentionOpen, notesEnabled])

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
      // A thread on another host than this draft's names its host (`env_…`), so the draft's host reads it there.
      const inserted =
        m.kind === 'thread'
          ? threadToken(m.session.id, sessionStore.hostIdOf(m.session.environmentId), sessionStore.hostIdOf(environmentId))
          : `@${m.file.relative}`
      el.replaceRange(live.start, caret, { text: `${inserted} ` })
    }
    setTrigger(null)
  }

  useEffect(() => {
    if (!focused) return
    if (
      document.querySelector(
        '[data-model-picker], [data-access-picker], [data-add-menu], [data-file-picker], [data-branch-picker]'
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
      void attachmentsFromFiles(files).then(admitAttachments, attachFailed)
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
  }, [admitAttachments, attachFailed, attachmentsSupported, enabled])

  const submit = (value: string, invert = false) => {
    if (blocked || uploadingRef.current) return
    const text = composeInboxMessage(inboxCard, value)
    const files = attachments
    if (!text && files.length === 0 && !noteCard && !handoffCard) return
    // A file the thread's host cannot read (it is on this Mac, or only in
    // memory) is uploaded there first; the text and chips stay put until
    // every file landed, and a failure stays here on its chip.
    if (sessionId && files.some((file) => needsUpload(file, environmentId))) {
      void uploadThenSubmit(sessionId, invert)
      return
    }
    finishSubmit(text, files, invert)
  }

  const uploadThenSubmit = async (threadId: string, invert: boolean) => {
    uploadingRef.current = true
    setUploading(true)
    setAttachNote(null)
    const replace = (file: Attachment) => {
      attachmentsRef.current = attachmentsRef.current.map((a) => (a.id === file.id ? file : a))
      setAttachments(attachmentsRef.current)
    }
    try {
      const files = await uploadAttachments({
        threadEnv: environmentId,
        sessionId: threadId,
        files: attachmentsRef.current,
        onProgress: (id, progress) => setUploads((prev) => ({ ...prev, [id]: progress })),
        onUploaded: (file) => {
          replace(file)
          setUploads((prev) => {
            const next = { ...prev }
            delete next[file.id]
            return next
          })
        }
      })
      finishSubmit(composeInboxMessage(inboxCard, inputRef.current?.value() ?? ''), files, invert)
    } catch (error) {
      if (error instanceof AttachmentUploadError) {
        const id = error.fileId
        setUploads((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { sent: 0, total: 0 }), failed: true } }))
      }
      attachFailed(error)
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }

  const finishSubmit = (text: string, files: Attachment[], invert: boolean) => {
    const intent = decideComposerAction({
      busy,
      paused,
      hasText: true,
      invert,
      midTurnDefault
    })
    // The bubble slides in from where the prompt sat; the field clears on
    // the same frame so the text is never in two places at once.
    const field = boxRef.current?.querySelector('.composer-field')
    if (field) recordSendOrigin(field.getBoundingClientRect())
    onSubmit(text, files, intent === 'pause' ? 'send' : intent)
    inputRef.current?.clear()
    setAttachments([])
    setUploads({})
    setAttachNote(null)
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
    void attachmentsFromFiles(files).then(admitAttachments, attachFailed)
  }

  // A pasted log or file's worth of text rides as a file, not as typed
  // text — a contenteditable holding 100 KB crawls on every keystroke.
  const attachLargePaste = useCallback(
    (file: File) => {
      void attachmentsFromFiles([file]).then(admitAttachments, attachFailed)
    },
    [admitAttachments, attachFailed]
  )

  const attachFromPicker = () => {
    if (!attachmentsSupported) return
    void pickAttachments().then((files) => {
      admitAttachments(files)
      inputRef.current?.focus()
    }, attachFailed)
  }

  const fieldOf = () => boxRef.current?.querySelector<HTMLElement>('[data-composer-input]') ?? null

  /** The `+` menu's Mention and Skills rows: type the mark at the caret so the list opens there. */
  const insertTrigger = (mark: '@' | '/') => {
    const input = inputRef.current
    if (!input) return
    input.insertText(triggerInsert(draftRef.current, caretRef.current, mark))
  }

  return (
    <div
      data-composer
      className={`relative shrink-0 ${shell ? '' : 'p-1.5 pt-0'}`}
      onMouseDown={onFocus}
    >
      {children}
      <Lightbox />
      {sessionId ? (
        <GoalDialog sessionId={sessionId} goal={goal} onClose={() => inputRef.current?.focus()} />
      ) : null}
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
          className={`relative z-10 rounded-xl ${COMPOSER_SURFACE} has-focus:border-input`}
        >
          <AnimatePresence>
            {fileDrag ? (
              <motion.div
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={{ duration: DUR.fast, ease: EASE_OUT }}
                className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-accent/8 text-xs text-muted-foreground"
              >
                Drop files to attach
              </motion.div>
            ) : null}
          </AnimatePresence>

          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((file) => (
                <AttachmentChip
                  key={file.id}
                  environmentId={file.environmentId ?? environmentId}
                  attachment={file}
                  progress={uploads[file.id]}
                  onRemove={uploading ? undefined : () => removeAttachment(file.id)}
                  onOpen={
                    file.kind === 'image'
                      ? () => openAttachmentImages(environmentId, attachments, file)
                      : undefined
                  }
                />
              ))}
            </div>
          ) : null}

          {attachNote ? (
            <div role="alert" data-attach-note className="flex items-start gap-1 px-3 pt-1.5 text-xs text-destructive">
              <span className="min-w-0 flex-1 py-1">{attachNote}</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Dismiss"
                      onClick={() => setAttachNote(null)}
                      className="text-destructive/80 hover:text-destructive"
                    />
                  }
                >
                  <X />
                </TooltipTrigger>
                <TooltipContent>Dismiss</TooltipContent>
              </Tooltip>
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
              blocked
                ? blocked
                : inboxCard
                ? 'Add a note, or send to start…'
                : noteCard
                  ? 'Add a message, or send…'
                  : handoffCard
                    ? 'Add context, or send to continue…'
                    : shell
                      ? 'How can I help you today?'
                      : 'Ask, build, / for skills, @ for references... '
            }
            className="composer-field relative max-h-40 w-full px-3 pt-3 pb-2 font-sans text-[15px] leading-[1.6] text-foreground outline-none"
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

          <ComposerBar
            harness={harness}
            runtimeMode={runtimeMode}
            onRuntimeModeChange={onRuntimeModeChange}
            onAttach={attachFromPicker}
            onInsert={insertTrigger}
            fieldOf={fieldOf}
            onClose={() => inputRef.current?.focus()}
            model={
              <ModelPicker
                harness={harness}
                model={model}
                environmentId={environmentId}
                hotkeys={hotkeys && enabled}
                onChange={changeModel}
                onClose={() => inputRef.current?.focus()}
                settings={{ values: modelSettings, onChange: changeModelSettings, context }}
              />
            }
            send={
              <SendButton
                intent={intent}
                disabled={!!blocked || (intent !== 'pause' && !hasValue)}
                onSubmit={(invert) => submit(inputRef.current?.value() ?? '', invert)}
                onPause={() => onPause?.()}
              />
            }
          />
        </div>
        <div data-composer-draft-row className="mt-1 flex h-7 min-w-0 items-center gap-2 px-3 text-xs text-muted-foreground">
          {draft && !hideProjectPicker ? (
            <CwdPicker
              cwd={cwd}
              recents={recents}
              projectLogoPath={projectLogoPath}
              enabled={enabled}
              onCwdChange={onCwdChange}
              onNewTerminal={onNewTerminal}
              onClose={() => inputRef.current?.focus()}
            />
          ) : null}
          {draft && sessionId && enabled ? (
            <DraftHostPicker sessionId={sessionId} onClose={() => inputRef.current?.focus()} />
          ) : null}
          {/* The branch stays after the first message: it has no other home. */}
          <BranchPicker
            cwd={cwd}
            branch={branch}
            enabled={enabled && !busy}
            onChange={onBranchChange}
            onClose={() => inputRef.current?.focus()}
          />
          {draft && threadType && onThreadTypeChange ? (
            <ThreadTypeChip
              value={threadType}
              onChange={onThreadTypeChange}
              onClose={() => inputRef.current?.focus()}
            />
          ) : null}
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
