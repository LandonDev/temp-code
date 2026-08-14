import { memo, useEffect, useState } from 'react'
import type { Attachment } from '@shared/events'
import { cn } from '../../../lib/utils'
import { client } from '../../../lib/client'
import { useApp } from '../../../state/store'
import { ZIcon } from '../zicon'
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

function TokenizedText({ text }: { text: string }): React.JSX.Element {
  const openFileRef = useApp((s) => s.openFileRef)
  const parts = text.split(TOKEN)

  return (
    <>
      {parts.map((part, n) => {
        if (n % 2 === 1 && part.startsWith('@')) {
          const path = part.slice(1)
          return (
            <button
              key={n}
              onClick={() => openFileRef(path)}
              className="rounded-sm bg-accent px-1 font-mono text-[12px] text-foreground hover:underline"
            >
              {part}
            </button>
          )
        }
        if (n % 2 === 1 && part.startsWith('/')) {
          return (
            <span key={n} className="rounded-sm bg-accent px-1 font-medium">
              {part}
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
export const UserMessage = memo(function UserMessage({
  block
}: {
  block: UserBlock
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
              className="flex items-center gap-1.5 rounded-md border border-border bg-[oklch(1_0_0/3%)] px-2 py-1 text-xs text-muted-foreground"
            >
              <ZIcon name="document" size={12} />
              {a.name}
            </span>
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[80%] rounded-[16px] bg-bubble px-4 py-2.5 text-[14px] leading-[22px] whitespace-pre-wrap">
          <TokenizedText text={text} />
        </div>
      )}
    </div>
  )
})
