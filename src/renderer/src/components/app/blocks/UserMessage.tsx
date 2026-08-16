import { memo, useEffect, useState } from 'react'
import { FileText, MessageSquare } from 'lucide-react'
import type { Attachment } from '@shared/events'
import { cn } from '../../../lib/utils'
import { client } from '../../../lib/client'
import { useApp } from '../../../state/store'
import { ZIcon } from '../zicon'
import { duration } from '../bits'
import { AddonMark } from '../AddonMark'
import { addonTitle } from '../../../lib/addon-names'
import type { Block } from '../../../state/blocks'

type UserBlock = Extract<Block, { kind: 'user' }>

/** Thumbnail data URLs, fetched once per path for the app's lifetime. */
const thumbCache = new Map<string, Promise<string>>()
function thumbFor(path: string): Promise<string> {
  let p = thumbCache.get(path)
  if (!p) {
    p = client.request<string>('attachment.read', { path })
    thumbCache.set(path, p)
  }
  return p
}

/** Attachment thumbs ride above the bubble, right-aligned — 112×80. */
function ImageThumb({ a }: { a: Attachment }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void thumbFor(a.path)
      .then((url) => alive && setSrc(url))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [a.path])
  return (
    <div className="h-20 w-28 shrink-0 overflow-hidden rounded-[10px] border border-border bg-secondary">
      {src && <img src={src} alt={a.name} className="h-full w-full object-cover" />}
    </div>
  )
}

/** Message text with `/command` and `@path` tokens surfaced as what they
 *  are — skill chips (anywhere, any number) and clickable file references. */
const TOKEN = /(@[^\s@]{2,}|(?<=^|\s)\/[\w:-]+(?=$|\s))/g

function TokenizedText({
  text,
  sessionId
}: {
  text: string
  sessionId?: string
}): React.JSX.Element {
  const openFileRef = useApp((s) => s.openFileRef)
  const sessions = useApp((s) => s.sessions)
  const select = useApp((s) => s.select)
  // The session's own command list names each /ref's kind — a Linear
  // mention wears the Linear mark, a skill wears the skill glyph.
  const commands = useApp((s) => {
    const meta = sessionId ? s.sessions[sessionId] : undefined
    return meta ? s.commands[`${meta.provider}:${meta.cwd}`] : undefined
  })
  const parts = text.split(TOKEN)

  return (
    <>
      {parts.map((part, n) => {
        // Thread mentions (M9) stay human: the title, never the id.
        if (n % 2 === 1 && part.startsWith('@thread:')) {
          const id = part.slice('@thread:'.length)
          const thread = sessions[id]
          return (
            <button
              key={n}
              onClick={() => thread && void select(id)}
              title="Open thread"
              className="inline-flex items-center gap-1 rounded-sm bg-accent px-1 align-baseline text-[13px] text-foreground hover:underline"
            >
              <MessageSquare className="size-3 shrink-0 opacity-60" />
              {thread?.title ?? 'thread'}
            </button>
          )
        }
        if (n % 2 === 1 && part.startsWith('@')) {
          const path = part.slice(1)
          // The reference stays a real path underneath; the chip shows the
          // human name — basename, minus the attachment store's id prefix.
          const base = path.split('/').pop() ?? path
          const label = path.includes('/.temp-code/attachments/')
            ? base.replace(/^[\w-]{8}-/, '')
            : base
          return (
            <button
              key={n}
              onClick={() => openFileRef(path)}
              title={path}
              className="inline-flex items-center gap-1 rounded-sm bg-accent px-1 align-baseline font-mono text-[12px] text-foreground hover:underline"
            >
              <FileText className="size-3 shrink-0 opacity-60" />
              {label}
            </button>
          )
        }
        if (n % 2 === 1 && part.startsWith('/')) {
          const ref = commands?.find((c) => c.name === part.slice(1))
          const addon = ref && (ref.source === 'plugin' || ref.source === 'mcp')
          return (
            <span
              key={n}
              className="inline-flex items-center gap-1 rounded-sm bg-accent px-1 align-baseline font-medium"
            >
              {ref && <AddonMark command={ref} size={11} className="translate-y-px" />}
              {addon ? addonTitle(ref.name) : part}
            </span>
          )
        }
        return <span key={n}>{part}</span>
      })}
    </>
  )
}

/**
 * Zeron user message: a right-aligned translucent wash bubble — radius 16,
 * px 16 / py 10, 14/22 text, max 80% of the 736px column. The optimistic
 * echo renders at 65% opacity and snaps to full when the server confirms
 * (same row, so nothing reflows). An image-only send shows no bubble.
 */
/** How long the work this message kicked off took — settled sections show
 *  their final time, the one still running ticks. Quiet under 3s. */
function SectionTimer({
  block,
  sessionId
}: {
  block: UserBlock
  sessionId: string
}): React.JSX.Element | null {
  const live = useApp((s) => {
    if (block.doneTs !== undefined) return false
    const st = s.sessions[sessionId]?.status
    if (st !== 'running' && st !== 'starting') return false
    const blocks = s.blocks[sessionId]
    if (!blocks) return false
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'user') return blocks[i].ts === block.ts
    }
    return false
  })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  const start = block.ts
  if (start === undefined) return null
  const ms = block.doneTs !== undefined ? block.doneTs - start : live ? now - start : null
  if (ms === null || ms < 3000) return null
  return (
    <span className="mt-1 text-[10.5px] tabular-nums text-muted-foreground/60">{duration(ms)}</span>
  )
}

export const UserMessage = memo(function UserMessage({
  block,
  sessionId
}: {
  block: UserBlock
  sessionId: string
}): React.JSX.Element {
  const images = block.attachments?.filter((a) => a.kind === 'image') ?? []
  const files = block.attachments?.filter((a) => a.kind !== 'image') ?? []
  const text = block.text === '(see attachments)' && images.length > 0 ? '' : block.text

  return (
    <div
      className={cn(
        'flex flex-col items-end transition-opacity duration-150',
        block.pending && 'opacity-65'
      )}
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-1.5">
          {images.map((a) => (
            <ImageThumb key={a.path} a={a} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap justify-end gap-1.5">
          {files.map((a) => (
            <span
              key={a.path}
              title={a.path}
              className="flex items-center gap-1.5 rounded-md border border-border bg-(--chip-bg) px-2 py-1 text-xs text-muted-foreground"
            >
              <ZIcon name="document" size={12} />
              {a.name}
            </span>
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[80%] rounded-[16px] bg-bubble px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap">
          <TokenizedText text={text} sessionId={sessionId} />
        </div>
      )}
      <SectionTimer block={block} sessionId={sessionId} />
    </div>
  )
})
