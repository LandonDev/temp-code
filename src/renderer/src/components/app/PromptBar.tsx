import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Paperclip,
  SlashSquare,
  Square,
  X
} from 'lucide-react'
import type { ProviderId, Reasoning } from '@shared/catalog'
import type { Attachment, PermissionPolicy } from '@shared/events'
import type { SlashCommand } from '@shared/domain'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { EASE_OUT, SPRING_PANEL, SPRING_SWAP } from '../../lib/ease'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '../ui/select'

const REASONING_LABELS: Record<Reasoning, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
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
  // Skills complete anywhere a word starts with `/` — the drivers expand
  // every reference, so mid-message and repeated skills all execute.
  if (token.startsWith('/') && !token.includes('/', 1)) {
    return { mode: 'command', query: token.slice(1), start }
  }
  if (token.startsWith('@') && !token.includes('@', 1)) {
    return { mode: 'file', query: token.slice(1), start }
  }
  return null
}

function rankFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, 8)
  const q = query.toLowerCase()
  const scored: { p: string; s: number }[] = []
  for (const p of files) {
    const lower = p.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    const s = base.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : lower.includes(q) ? 2 : -1
    if (s >= 0) scored.push({ p, s })
    if (scored.length > 400) break
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length)
    .slice(0, 8)
    .map((x) => x.p)
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
  const fetchCommands = useApp((s) => s.fetchCommands)
  const fetchFiles = useApp((s) => s.fetchFiles)
  const saveAttachment = useApp((s) => s.saveAttachment)
  const send = useApp((s) => s.send)
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
  // thread's provider on the next send.
  const [choice, setChoice] = useState<{ provider: ProviderId; model: string }>({
    provider: session?.provider ?? 'claude',
    model: session?.model ?? ''
  })
  const [reasoning, setReasoning] = useState<Reasoning>(session?.reasoning ?? 'medium')
  const reduce = useReducedMotion()
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  const chosen = catalog?.[choice.provider]
  const providerId = session?.provider
  const cwd = session?.cwd

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
    return rankFiles(projectFiles ?? [], trigger.query)
  }, [trigger, dismissed, commands, projectFiles])
  const open = matches.length > 0
  const selectionKey = trigger ? `${trigger.mode}:${trigger.query}` : ''
  const active = selection.key === selectionKey ? Math.min(selection.index, matches.length - 1) : 0
  const setActive = (index: number): void => setSelection({ key: selectionKey, index })

  useEffect(() => {
    listRef.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

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

  const accept = (index: number): void => {
    if (!trigger) return
    const m = matches[index]
    if (m === undefined) return
    const inserted = trigger.mode === 'command' ? `/${(m as SlashCommand).name}` : `@${m as string}`
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

  const submit = (): void => {
    const t = text.trim()
    if (!t && images.length === 0) return
    const attachments = [...images.map((i) => i.attachment), ...fileRefs]
    setText('')
    for (const i of images) URL.revokeObjectURL(i.previewUrl)
    setImages([])
    setFileRefs([])
    void send(selectedId, t || '(see attachments)', {
      provider: choice.provider !== session.provider ? choice.provider : undefined,
      model: choice.model || undefined,
      reasoning,
      attachments: attachments.length ? attachments : undefined
    })
  }

  const removeImage = (path: string): void => {
    setImages((prev) => {
      const gone = prev.find((i) => i.attachment.path === path)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((i) => i.attachment.path !== path)
    })
  }

  return (
    <div className={cn('shrink-0 px-6 pb-3', compact ? 'pt-1' : 'pt-2')}>
      <div className="relative mx-auto w-full max-w-3xl">
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
                  : (matches as string[]).map((p, n) => {
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
                    })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className={cn(
            'rounded-xl border bg-popover shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_16px_rgb(0_0_0/0.06)] transition-shadow focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_6px_24px_rgb(0_0_0/0.09)]',
            compact ? 'px-3 py-1.5' : 'px-3.5 py-2.5'
          )}
        >
          {(images.length > 0 || fileRefs.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pb-2">
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
                    title={f.path}
                    className="flex items-center gap-1.5 rounded-md border bg-secondary/50 py-1 pr-1 pl-2 text-xs text-muted-foreground"
                  >
                    <FileText className="size-3" />
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
          <div className="flex items-end gap-2">
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
                  submit()
                }
              }}
              rows={Math.min(8, Math.max(1, text.split('\n').length))}
              placeholder={
                session.threadType === 'chat' || !session.threadType
                  ? 'Message…'
                  : 'Steer or follow up…'
              }
              aria-label="Message"
              className="flex-1 resize-none self-center bg-transparent text-[13px] leading-5 outline-none placeholder:text-muted-foreground/70"
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
            <button
              onClick={() => pickerRef.current?.click()}
              aria-label="Attach files"
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition hover:bg-accent hover:text-foreground active:scale-95"
            >
              <Paperclip className="size-3.5" />
            </button>
            <button
              onClick={() => (running ? void interrupt(selectedId) : submit())}
              disabled={!running && !text.trim() && images.length === 0}
              aria-label={running ? 'Stop' : 'Send'}
              className={cn(
                'relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full transition active:scale-95',
                running
                  ? 'bg-foreground text-background'
                  : text.trim() || images.length
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground'
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={running ? 'stop' : 'send'}
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
                  {running ? (
                    <Square className="size-3 fill-current" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
        </div>
        <div className="flex h-7 items-center pt-1">
          {catalog && chosen && (
            <>
              <Select
                value={`${choice.provider}::${choice.model}`}
                onValueChange={(v) => {
                  const [p, m] = v.split('::') as [ProviderId, string]
                  setChoice({ provider: p, model: m })
                  // Reasoning options differ per harness; keep the pick valid.
                  const opts = catalog[p]?.reasoning ?? []
                  if (opts.length > 0 && !opts.includes(reasoning)) {
                    setReasoning(opts.includes('medium') ? 'medium' : opts[0])
                  }
                }}
              >
                <SelectTrigger
                  aria-label="Model"
                  className="h-6 gap-1 rounded-md border-0 bg-transparent py-0 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent/50 [&_svg]:size-3"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(catalog).map((p) => (
                    <SelectGroup key={p.id}>
                      <SelectLabel className="text-[11px] text-muted-foreground/70">
                        {p.label}
                      </SelectLabel>
                      {p.models.map((m) => (
                        <SelectItem key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`} className="text-xs">
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {chosen.reasoning.length > 1 && (
                <Select value={reasoning} onValueChange={(v) => setReasoning(v as Reasoning)}>
                  <SelectTrigger
                    aria-label="Reasoning effort"
                    className="h-6 gap-1 rounded-md border-0 bg-transparent py-0 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent/50 [&_svg]:size-3"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {chosen.reasoning.map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
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
                <SelectTrigger
                  aria-label="Permission level"
                  className="ml-auto h-6 gap-1 rounded-md border-0 bg-transparent py-0 pr-1 pl-1.5 text-[11px] text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent/50 [&_svg]:size-3"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PERMISSION_LABELS) as PermissionPolicy[]).map((p) => (
                    <SelectItem key={p} value={p} className="text-xs">
                      {PERMISSION_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
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
