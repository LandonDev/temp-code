import { useEffect, useRef, useState } from 'react'
import { X } from './icons'
import { attachmentPreviewSrc } from '../lib/attachments'
import type { Attachment } from '../lib/session'
import { FileTypeIcon } from './FileTypeIcon'
import { useNearViewport } from '../hooks/useNearViewport'
import { imageDataFor, openLightbox, type LightboxItem } from './Lightbox'

/** A history image carries only its path; the server hands back its bytes
 *  once, asked for when the chip is about to be seen. */
function useAttachmentSrc(environmentId: string, attachment: Attachment, wanted: boolean): string | undefined {
  const direct = attachmentPreviewSrc(attachment)
  const path = !direct && attachment.kind === 'image' ? attachment.path : undefined
  const [fetched, setFetched] = useState<{ environmentId: string; path: string; src: string | null } | null>(null)
  useEffect(() => {
    if (!path || !wanted) return
    let live = true
    void imageDataFor(environmentId, path).then((src) => {
      if (live) setFetched({ environmentId, path, src })
    })
    return () => {
      live = false
    }
  }, [environmentId, path, wanted])
  return direct ?? (fetched?.environmentId === environmentId && fetched.path === path ? fetched.src ?? undefined : undefined)
}

/** Open the viewer on `files`' images, starting at `at`. */
export function openAttachmentImages(environmentId: string, files: readonly Attachment[], at: Attachment): void {
  const images = files.filter((file) => file.kind === 'image')
  const items: LightboxItem[] = images.map((file) => ({
    // A file still on the host it was attached from reads from there.
    environmentId: file.environmentId ?? environmentId,
    name: file.name,
    src: attachmentPreviewSrc(file),
    path: file.path
  }))
  openLightbox(items, Math.max(0, images.indexOf(at)))
}

type Props = {
  environmentId: string
  attachment: Attachment
  onRemove?: () => void
  /** Image chips open the viewer when this is given. */
  onOpen?: () => void
  /** An upload to the thread's host in flight (or failed): a bar along the chip's foot. */
  progress?: { sent: number; total: number; failed?: boolean }
}

function UploadBar({ progress }: { progress: NonNullable<Props['progress']> }) {
  const fraction = progress.total > 0 ? Math.min(1, progress.sent / progress.total) : progress.failed ? 1 : 0
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 overflow-hidden rounded-full bg-content/15"
    >
      <span
        className={`block h-full rounded-full transition-[width] duration-150 ${progress.failed ? 'bg-danger' : 'bg-accent'}`}
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </span>
  )
}

export function AttachmentChip({ environmentId, attachment, onRemove, onOpen, progress }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const preview = useAttachmentSrc(environmentId, attachment, useNearViewport(ref))
  const image = attachment.kind === 'image' && preview
  const percent = progress && progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
  const title = progress
    ? progress.failed
      ? `${attachment.name}: upload failed`
      : `${attachment.name}: uploading to the thread's host, ${percent}%`
    : (attachment.path ?? attachment.name)

  return (
    <div
      ref={ref}
      className={`group relative flex min-w-0 items-center gap-1.5 rounded-md ${
        image ? '' : 'bg-content/10 py-0.5 pl-1 pr-1'
      } ${progress?.failed ? 'ring-1 ring-danger/60' : ''}`}
      title={title}
      data-attachment-path={attachment.path}
      data-upload={progress ? (progress.failed ? 'failed' : String(percent)) : undefined}
    >
      {progress ? <UploadBar progress={progress} /> : null}
      {image ? (
        onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Preview ${attachment.name}`}
            className={`block size-9 shrink-0 cursor-zoom-in overflow-hidden rounded-lg ${attachment.textPath ? 'w-14' : ''}`}
          >
            <img src={preview} alt="" decoding="async" className={`size-full object-cover ${attachment.textPath ? 'w-14' : ''}`} />
          </button>
        ) : (
          <img src={preview} alt="" decoding="async" className={`size-9 shrink-0 rounded-lg object-cover ${attachment.textPath ? 'w-14' : ''}`} />
        )
      ) : (
        <>
          <span className="grid size-5 shrink-0 place-items-center">
            <FileTypeIcon name={attachment.name} isDir={false} size={16} />
          </span>
          <span className="min-w-0 max-w-[140px] truncate text-[11px] leading-none text-content/70">
            {attachment.name}
          </span>
        </>
      )}
      {onRemove ? (
        <button
          type="button"
          title="Remove"
          aria-label={`Remove ${attachment.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className={`grid shrink-0 place-items-center rounded-full text-content/70 hover:bg-content/15 hover:text-content ${
            image
              ? 'absolute -right-1 -top-1 size-5 bg-content/20 opacity-100'
              : 'size-4 text-content/40'
          }`}
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  )
}
