import { memo, useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import type { Attachment } from '@shared/events'
import { client } from '../../../lib/client'
import { useApp } from '../../../state/store'
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
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border bg-secondary">
      {src && <img src={src} alt={a.name} className="h-full w-full object-cover" />}
    </div>
  )
}

/** Message text with `/command` and `@path` tokens surfaced as what they
 *  are — skill chips (anywhere, any number) and clickable file references.
 *  A `/token` only chips as a standalone word, so `/etc/hosts` stays text. */
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

export const UserMessage = memo(function UserMessage({
  block
}: {
  block: UserBlock
}): React.JSX.Element {
  const images = block.attachments?.filter((a) => a.kind === 'image') ?? []
  const files = block.attachments?.filter((a) => a.kind !== 'image') ?? []
  return (
    <div className="rounded-xl border bg-card px-3.5 py-2.5 text-[13px] leading-5">
      {(images.length > 0 || files.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {images.map((a) => (
            <ImageThumb key={a.path} a={a} />
          ))}
          {files.map((a) => (
            <span
              key={a.path}
              title={a.path}
              className="flex items-center gap-1.5 rounded-md border bg-secondary/50 px-2 py-1 text-xs text-muted-foreground"
            >
              <FileText className="size-3" />
              {a.name}
            </span>
          ))}
        </div>
      )}
      <div className="whitespace-pre-wrap">
        <TokenizedText text={block.text} />
      </div>
    </div>
  )
})
