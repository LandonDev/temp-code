import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileText, Image as ImageIcon, MessageSquare, SlashSquare, X } from 'lucide-react'
import type { ProviderId, Reasoning } from '@shared/catalog'
import type { Attachment, PermissionPolicy, SessionMeta } from '@shared/events'
import type { SlashCommand } from '@shared/domain'
import { useApp } from '../../state/store'
import { cn, displayPath } from '../../lib/utils'
import { EASE_OUT, SPRING_PANEL, SPRING_SWAP } from '../../lib/ease'
import { StatusDot, timeAgo } from './bits'
import { MessageQueue } from './MessageQueue'
import { ZIcon } from './zicon'
import { ModelPicker } from './ModelPicker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { rankFiles } from '../../lib/rank'

const REASONING_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

const PERMISSION_LABELS: Record<PermissionPolicy, string> = {
  safe: 'Ask first',
  edits: 'Auto-edits',
  auto: 'Full access'
}

/** A pending image attachment plus its local preview. */
interface PendingImage {
  attachment: Attachment
  previewUrl: string
}

const toBase64 = async (file: File): Promise<string> => {
  const buf = await file.arrayBuffer()
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** The token under the caret, if it triggers autocomplete. */
function triggerAt(
  text: string,
  caret: number
): { mode: 'command' | 'file'; query: string; start: number } | null {
  const before = text.slice(0, caret)
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1
  const token = before.slice(start)
  // Slash commands only mean something at the start of the message.
  if (start === 0 && token.startsWith('/')) return { mode: 'command', query: token.slice(1), start }
  if (token.startsWith('@') && !token.includes('@', 1)) {
    return { mode: 'file', query: token.slice(1), start }
  }
  return null
}

/** One entry in the @ menu: a project file or a referencable thread (M9). */
type AtMatch = { kind: 'file'; path: string } | { kind: 'thread'; session: SessionMeta }

/** Threads mentionable from this composer: every non-archived root thread
 *  except the current one — current project's first, then the rest, most
 *  recently active first. */
function rankThreads(
  sessions: Record<string, SessionMeta>,
  query: string,
  currentId: string,
  currentProjectId: string | null
): SessionMeta[] {
  const q = query.toLowerCase()
  return Object.values(sessions)
    .filter(
      (s) =>
        !s.parentId &&
        !s.archived &&
        s.id !== currentId &&
        (!q || s.title.toLowerCase().includes(q))
    )
    .sort(
      (a, b) =>
        Number(b.projectId === currentProjectId) - Number(a.projectId === currentProjectId) ||
        b.updatedAt - a.updatedAt
    )
    .slice(0, query ? 5 : 3)
}

/**
 * The composer: a floating rounded surface. Send morphs into Stop while a
 * turn runs; typing stays enabled (the harness queues messages).
 *
 * `/` completes the provider's skills/commands/prompts, `@` completes
 * project files. Images paste/drop in as attachments; other dropped files
 * become @path references. Model and reasoning ride along per message.
 */
export function PromptBar({ compact }: { compact?: boolean }): React.JSX.Element | null {
  const selectedId = useApp((s) => s.selectedId)
  const session = useApp((s) => (s.selectedId ? s.sessions[s.selectedId] : undefined))
  const catalog = useApp((s) => s.catalog)
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const commands = useApp((s) =>
    session ? s.commands[`${session.provider}:${session.cwd}`] : undefined
  )
  const projectFiles = useApp((s) => (project ? s.files[project.id] : undefined))
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  const fetchCommands = useApp((s) => s.fetchCommands)
  const fetchFiles = useApp((s) => s.fetchFiles)
  const saveAttachment = useApp((s) => s.saveAttachment)
  const send = useApp((s) => s.send)
  const queueAdd = useApp((s) => s.queueAdd)
  const midTurnDefault = useApp((s) => s.midTurnDefault)
  const interrupt = useApp((s) => s.interrupt)
  const setPermission = useApp((s) => s.setPermission)

  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Selection is remembered per (mode, query) so a new keystroke resets to
  // the top without an effect.
  const [selection, setSelection] = useState<{ key: string; index: number }>({ key: '', index: 0 })
  const [images, setImages] = useState<PendingImage[]>([])
  const [fileRefs, setFileRefs] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  // Seeded from the session's last-used values; the component remounts per
  // thread (ThreadView is keyed), so this state is per thread. The choice
  // spans providers — picking a model from another harness switches the
  // thread to it on the next send.
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string }>({
    provider: session?.provider ?? 'claude',
    model: session?.model ?? ''
  })
  const [reasoning, setReasoning] = useState<Reasoning>(session?.reasoning ?? 'medium')
  const reduce = useReducedMotion()
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  const provider = session ? catalog?.[choice.provider] : undefined
  const providerId = session ? choice.provider : undefined
  const cwd = session?.cwd
  // Reasoning is per model — the ladder (and whether the select shows at
  // all) comes from the picked model's catalog entry.
  const ladder = provider?.models.find((m) => m.id === choice.model)?.reasoning ?? []

  useEffect(() => {
    if (providerId && cwd) void fetchCommands(providerId, cwd)
  }, [providerId, cwd, fetchCommands])
  useEffect(() => {
    if (project) void fetchFiles(project.id)
  }, [project, fetchFiles])

  const trigger = useMemo(() => triggerAt(text, caret), [text, caret])
  const matches = useMemo(() => {
    if (!trigger || `${trigger.mode}:${trigger.start}` === dismissed) return []
    if (trigger.mode === 'command') {
      const q = trigger.query.toLowerCase()
      return (commands ?? []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
    }
    // One flat list for the keyboard, grouped in render: files, then threads.
    return [
      ...rankFiles(projectFiles ?? [], trigger.query).map((path): AtMatch => ({
        kind: 'file',
        path
      })),
      ...rankThreads(sessions, trigger.query, selectedId ?? '', project?.id ?? null).map(
        (session): AtMatch => ({ kind: 'thread', session })
      )
    ]
  }, [trigger, dismissed, commands, projectFiles, sessions, selectedId, project])
  const open = matches.length > 0
  const selectionKey = trigger ? `${trigger.mode}:${trigger.query}` : ''
  const active = selection.key === selectionKey ? Math.min(selection.index, matches.length - 1) : 0
  const setActive = (index: number): void => setSelection({ key: selectionKey, index })

  useEffect(() => {
    listRef.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Composer morph (Zeron FlipMorph): the textarea auto-grows one line →
  // 260px and every height change tweens 180ms ease-out. The pill sits at
  // the bottom of the column, so growth is bottom-anchored.
  useLayoutEffect(() => {
    const a = areaRef.current
    if (!a) return
    const prev = a.style.height
    a.style.transition = 'none'
    a.style.height = 'auto'
    const target = Math.min(260, a.scrollHeight)
    a.style.height = prev || `${target}px`
    void a.offsetHeight
    a.style.transition = 'height 180ms ease-out'
    a.style.height = `${target}px`
  }, [text])

  const attachImage = useCallback(
    async (file: File): Promise<void> => {
      const attachment = await saveAttachment(file.name || 'image.png', await toBase64(file))
      const previewUrl = URL.createObjectURL(file)
      setImages((prev) => [...prev, { attachment, previewUrl }])
    },
    [saveAttachment]
  )

  const addFileRef = useCallback(
    (path: string): void => {
      // Prefer a project-relative reference when the file lives inside it.
      const root = project?.cwd ? `${project.cwd.replace(/\/$/, '')}/` : null
      const ref = root && path.startsWith(root) ? path.slice(root.length) : path
      setFileRefs((prev) =>
        prev.some((a) => a.path === path)
          ? prev
          : [...prev, { path, name: path.split('/').pop() ?? path, kind: 'file' }]
      )
      setText((t) => {
        const sep = t.length === 0 || /\s$/.test(t) ? '' : ' '
        return `${t}${sep}@${ref} `
      })
    },
    [project]
  )

  // Window-level drop: anywhere on the app attaches to the open thread.
  useEffect(() => {
    if (!selectedId) return
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (--depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      for (const file of e.dataTransfer?.files ?? []) {
        if (file.type.startsWith('image/')) {
          void attachImage(file)
        } else {
          const path = window.api.getPathForFile(file)
          if (path) addFileRef(path)
        }
      }
      areaRef.current?.focus()
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [selectedId, attachImage, addFileRef])

  if (!selectedId || !session) return null
  const running = session.status === 'running' || session.status === 'starting'
  const canSend = !!text.trim() || images.length > 0
  // FlipMorph: a short single-line prompt keeps the 49px compact pill with
  // the whole cluster inline; anything more expands (180ms, bottom-anchored).
  const expanded =
    images.length > 0 || fileRefs.length > 0 || text.includes('\n') || text.length > 40

  const accept = (index: number): void => {
    if (!trigger) return
    const m = matches[index]
    if (m === undefined) return
    let inserted: string
    if (trigger.mode === 'command') {
      inserted = `/${(m as SlashCommand).name}`
    } else if ((m as AtMatch).kind === 'thread') {
      const t = (m as Extract<AtMatch, { kind: 'thread' }>).session
      inserted = `@thread:${t.id}`
      setFileRefs((prev) =>
        prev.some((a) => a.sessionId === t.id)
          ? prev
          : [...prev, { path: `thread:${t.id}`, name: t.title, kind: 'thread', sessionId: t.id }]
      )
    } else {
      inserted = `@${(m as Extract<AtMatch, { kind: 'file' }>).path}`
    }
    const next = `${text.slice(0, trigger.start)}${inserted} ${text.slice(caret)}`
    setText(next)
    setDismissed(null)
    const pos = trigger.start + inserted.length + 1
    requestAnimationFrame(() => {
      areaRef.current?.focus()
      areaRef.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  /** invert=true = the ⌘Enter path: do the NON-default mid-turn action. */
  const submit = (invert = false): void => {
    const t = text.trim()
    if (!t && images.length === 0) return
    const attachments = [...images.map((i) => i.attachment), ...fileRefs]
    setText('')
    for (const i of images) URL.revokeObjectURL(i.previewUrl)
    setImages([])
    setFileRefs([])
    const opts = {
      provider: session && choice.provider !== session.provider ? choice.provider : undefined,
      model: choice.model || undefined,
      reasoning,
      attachments: attachments.length ? attachments : undefined
    }
    const body = t || '(see attachments)'
    // Mid-turn: Enter does the default (settings), ⌘Enter the other.
    const midTurnAction = (midTurnDefault === 'queue') !== invert ? 'queue' : 'steer'
    if (running && midTurnAction === 'queue') {
      void queueAdd(selectedId, body, opts)
      return
    }
    void send(selectedId, body, opts)
  }

  const removeImage = (path: string): void => {
    setImages((prev) => {
      const gone = prev.find((i) => i.attachment.path === path)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((i) => i.attachment.path !== path)
    })
  }

  return (
    <div className={cn('shrink-0 px-6 pb-3', compact ? 'pt-0.5' : 'pt-1')}>
      <div className="relative mx-auto w-full max-w-[688px]">
        <MessageQueue sessionId={selectedId} />
        <AnimatePresence>
          {open && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_PANEL }}
              exit={
                reduce
                  ? undefined
                  : { opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.1, ease: EASE_OUT } }
              }
              style={{ transformOrigin: 'bottom left' }}
              className="absolute right-0 bottom-full left-0 z-30 mb-2"
            >
              <div
                ref={listRef}
                className="max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 shadow-[0_4px_24px_rgb(0_0_0/0.08)]"
              >
                {trigger?.mode === 'command'
                  ? (matches as SlashCommand[]).map((c, n) => (
                      <button
                        key={`${c.scope}:${c.name}`}
                        data-active={n === active}
                        onMouseEnter={() => setActive(n)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          accept(n)
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left',
                          n === active && 'bg-accent'
                        )}
                      >
                        <SlashSquare className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 text-[13px] font-medium">/{c.name}</span>
                        {c.description && (
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {c.description}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/60">
                          {c.source}
                        </span>
                      </button>
                    ))
                  : (matches as AtMatch[]).map((m, n) => {
                      // Grouped render over one flat keyboard list: a quiet
                      // label where the files end and the threads begin.
                      const firstThread =
                        m.kind === 'thread' && (matches as AtMatch[])[n - 1]?.kind !== 'thread'
                      const mixed = (matches as AtMatch[]).some((x) => x.kind === 'file')
                      const label =
                        firstThread && mixed ? (
                          <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground/60">
                            Threads
                          </div>
                        ) : null
                      if (m.kind === 'file') {
                        const p = m.path
                        const base = p.split('/').pop()
                        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
                        return (
                          <button
                            key={p}
                            data-active={n === active}
                            onMouseEnter={() => setActive(n)}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              accept(n)
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left',
                              n === active && 'bg-accent'
                            )}
                          >
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="shrink-0 text-[13px]">{base}</span>
                            {dir && (
                              <span className="min-w-0 truncate text-xs text-muted-foreground/60">
                                {dir}
                              </span>
                            )}
                          </button>
                        )
                      }
                      const t = m.session
                      const foreign = t.projectId !== (project?.id ?? null)
                      const projectName = foreign
                        ? projects.find((p) => p.id === t.projectId)?.name
                        : undefined
                      return (
                        <div key={t.id}>
                          {label}
                          <button
                            data-active={n === active}
                            onMouseEnter={() => setActive(n)}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              accept(n)
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left',
                              n === active && 'bg-accent'
                            )}
                          >
                            <span className="flex size-3.5 shrink-0 items-center justify-center">
                              <StatusDot status={t.status} className="size-2" />
                              {!['running', 'waiting', 'error', 'starting'].includes(t.status) && (
                                <MessageSquare className="size-3.5 text-muted-foreground" />
                              )}
                            </span>
                            <span className="min-w-0 truncate text-[13px]">{t.title}</span>
                            {projectName && (
                              <span className="shrink-0 text-xs text-muted-foreground/60">
                                {projectName}
                              </span>
                            )}
                            <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/60">
                              {timeAgo(t.updatedAt)}
                            </span>
                          </button>
                        </div>
                      )
                    })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Zeron composer pill: white/3% fill, hairline border, radius 16.
            Bottom-anchored in the layout, so height morphs grow upward.
            Light mode separates with a soft shadow instead. */}
        <div className="relative rounded-[16px] border border-border bg-input shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.06)] transition-colors duration-150 focus-within:border-border-strong dark:shadow-none">
          {(images.length > 0 || fileRefs.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-3">
              <AnimatePresence initial={false}>
                {images.map((img) => (
                  <motion.div
                    key={img.attachment.path}
                    layout
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1, transition: SPRING_SWAP }}
                    exit={
                      reduce ? undefined : { opacity: 0, scale: 0.9, transition: { duration: 0.1 } }
                    }
                    className="group relative"
                  >
                    <img
                      src={img.previewUrl}
                      alt={img.attachment.name}
                      className="h-12 w-12 rounded-lg border object-cover"
                    />
                    <button
                      onClick={() => removeImage(img.attachment.path)}
                      aria-label={`Remove ${img.attachment.name}`}
                      className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition group-hover:opacity-100 hover:text-foreground active:scale-95"
                    >
                      <X className="size-2.5" />
                    </button>
                  </motion.div>
                ))}
                {fileRefs.map((f) => (
                  <motion.span
                    key={f.path}
                    layout
                    initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1, transition: SPRING_SWAP }}
                    exit={
                      reduce ? undefined : { opacity: 0, scale: 0.9, transition: { duration: 0.1 } }
                    }
                    title={f.kind === 'thread' ? f.name : f.path}
                    className="flex items-center gap-1.5 rounded-md border bg-secondary/50 py-1 pr-1 pl-2 text-xs text-muted-foreground"
                  >
                    {f.kind === 'thread' ? (
                      <MessageSquare className="size-3" />
                    ) : (
                      <FileText className="size-3" />
                    )}
                    {f.name}
                    <button
                      onClick={() => setFileRefs((prev) => prev.filter((a) => a.path !== f.path))}
                      aria-label={`Remove ${f.name}`}
                      className="flex size-4 items-center justify-center rounded-sm transition hover:bg-accent hover:text-foreground active:scale-95"
                    >
                      <X className="size-2.5" />
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          )}
          <textarea
            ref={areaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
              setDismissed(null)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
              if (files.length) {
                e.preventDefault()
                for (const f of files) void attachImage(f)
              }
            }}
            onKeyDown={(e) => {
              if (open) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive(
                    (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
                  )
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  accept(active)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  if (trigger) setDismissed(`${trigger.mode}:${trigger.start}`)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(e.metaKey)
              }
            }}
            rows={1}
            placeholder="Do anything…"
            aria-label="Message"
            className={cn(
              'block w-full resize-none bg-transparent pl-4 text-[14px] leading-[22.75px] outline-none placeholder:text-faint',
              expanded ? 'pt-3.5 pr-4' : 'py-[13px] pr-[300px]'
            )}
          />
          <input
            ref={pickerRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              for (const file of e.target.files ?? []) {
                if (file.type.startsWith('image/')) {
                  void attachImage(file)
                } else {
                  const path = window.api.getPathForFile(file)
                  if (path) addFileRef(path)
                }
              }
              e.target.value = ''
            }}
          />
          {/* expanded mode reserves a 46px actions strip; compact collapses
              it so the cluster shares the single 49px row */}
          <div
            className="transition-[height] duration-[180ms] ease-out"
            style={{ height: expanded ? 46 : 0 }}
          />
          {/* the cluster rides the pill's bottom-right through the morph */}
          <div className="absolute right-2.5 bottom-[9px] flex items-center gap-0.5">
            {provider && (
              <>
                <ModelPicker
                  provider={choice.provider}
                  model={choice.model}
                  onPick={(p, m) => {
                    setChoice({ provider: p, model: m })
                    // Clamp to the picked MODEL's ladder; land on its
                    // default effort when the current level isn't offered.
                    const next = catalog?.[p].models.find((x) => x.id === m)
                    const steps = next?.reasoning ?? []
                    if (!steps.includes(reasoning)) {
                      setReasoning(next?.defaultReasoning ?? steps[0] ?? 'medium')
                    }
                  }}
                />
                {ladder.length > 1 && (
                  <Select value={reasoning} onValueChange={(v) => setReasoning(v as Reasoning)}>
                    <SelectTrigger size="sm" aria-label="Reasoning effort" className="gap-1 px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ladder.map((r) => (
                        <SelectItem key={r} value={r}>
                          {REASONING_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Select
                  value={session.permission}
                  onValueChange={(v) => void setPermission(selectedId, v as PermissionPolicy)}
                >
                  <SelectTrigger size="sm" aria-label="Permission level" className="gap-1 px-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PERMISSION_LABELS) as PermissionPolicy[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PERMISSION_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <div className="flex items-center gap-1.5 pl-1">
              <button
                onClick={() => pickerRef.current?.click()}
                aria-label="Attach files"
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
              >
                <ZIcon name="paperclip" size={14} />
              </button>
              {/* Send / Queue / Steer / Stop: idle → send; running + text →
                  the settings default (⌘Enter or ⌘click does the other);
                  running + empty → stop (red square). */}
              <button
                onClick={(e) =>
                  running && !canSend ? void interrupt(selectedId) : submit(e.metaKey)
                }
                disabled={!running && !canSend}
                aria-label={
                  running
                    ? canSend
                      ? midTurnDefault === 'queue'
                        ? 'Queue'
                        : 'Steer'
                      : 'Stop'
                    : 'Send'
                }
                title={
                  running && canSend
                    ? midTurnDefault === 'queue'
                      ? 'Enter queues · ⌘Enter steers the running turn'
                      : 'Enter steers the running turn · ⌘Enter queues'
                    : undefined
                }
                // The send circle is always the near-white solid plate
                // (Zeron keeps it lit even while the input is empty).
                className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-primary-foreground transition active:scale-95"
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={
                      running && !canSend
                        ? 'stop'
                        : running && midTurnDefault === 'queue'
                          ? 'queue'
                          : 'send'
                    }
                    initial={reduce ? false : { opacity: 0, scale: 0.5, filter: 'blur(4px)' }}
                    animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', transition: SPRING_SWAP }}
                    exit={
                      reduce
                        ? undefined
                        : {
                            opacity: 0,
                            scale: 0.5,
                            filter: 'blur(4px)',
                            transition: { duration: 0.12, ease: EASE_OUT }
                          }
                    }
                    className="flex items-center justify-center"
                  >
                    {running && !canSend ? (
                      <span className="block size-2.5 rounded-[2px] bg-destructive" />
                    ) : running && midTurnDefault === 'queue' ? (
                      <ZIcon name="checklist" size={14} />
                    ) : (
                      <ZIcon name="arrow-up" size={15} />
                    )}
                  </motion.span>
                </AnimatePresence>
              </button>
            </div>
          </div>
        </div>
        {/* quiet meta row below the pill: checkout · branch */}
        <div className="flex h-7 items-center justify-between px-1.5 text-[11px] text-faint">
          <span
            className="flex items-center gap-1.5"
            title={session.cwd ? displayPath(session.cwd) : undefined}
          >
            <ZIcon name="folder" size={12} />
            {project?.mode === 'worktree' ? 'Worktree' : 'Local checkout'}
          </span>
          {project?.branch && (
            <span className="flex items-center gap-1.5">
              <ZIcon name="git-branch" size={12} />
              {project.branch}
            </span>
          )}
        </div>

        <AnimatePresence>
          {dragging && (
            <motion.div
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.12, ease: EASE_OUT }}
              className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/60 supports-backdrop-filter:backdrop-blur-xs"
            >
              <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-primary/40 bg-popover px-5 py-3.5 shadow-[0_8px_32px_rgb(0_0_0/0.10)]">
                <ImageIcon className="size-4 text-muted-foreground" />
                <span className="text-[13px]">Drop to attach</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
