import { useEffect, useState } from 'react'
import { X } from './icons'
import { attachmentPreviewSrc } from '../lib/attachments'
import type { Attachment } from '../lib/session'
import { FileTypeIcon } from './FileTypeIcon'
import { imageDataFor, openLightbox, type LightboxItem } from './Lightbox'

/** A history image carries only its path; the server hands back its bytes once. */
function useAttachmentSrc(attachment: Attachment): string | undefined {
  const direct = attachmentPreviewSrc(attachment)
  const path = !direct && attachment.kind === 'image' ? attachment.path : undefined
  const [fetched, setFetched] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    void imageDataFor(path).then((src) => {
      if (live) setFetched(src)
    })
    return () => {
      live = false
    }
  }, [path])
  return direct ?? (path ? (fetched ?? undefined) : undefined)
}

/** Open the viewer on `files`' images, starting at `at`. */
export function openAttachmentImages(files: readonly Attachment[], at: Attachment): void {
  const images = files.filter((file) => file.kind === 'image')
  const items: LightboxItem[] = images.map((file) => ({
    name: file.name,
    src: attachmentPreviewSrc(file),
    path: file.path
  }))
  openLightbox(items, Math.max(0, images.indexOf(at)))
}

type Props = {
  attachment: Attachment
  onRemove?: () => void
  /** Image chips open the viewer when this is given. */
  onOpen?: () => void
}

export function AttachmentChip({ attachment, onRemove, onOpen }: Props) {
  const preview = useAttachmentSrc(attachment)
  const image = attachment.kind === 'image' && preview

  return (
    <div
      className={`group relative flex min-w-0 items-center gap-1.5 rounded-md ${
        image ? '' : 'bg-content/10 py-0.5 pl-1 pr-1'
      }`}
      title={attachment.path ?? attachment.name}
      data-attachment-path={attachment.path}
    >
      {image ? (
        onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Preview ${attachment.name}`}
            className={`block size-9 shrink-0 cursor-zoom-in overflow-hidden rounded-lg ${attachment.textPath ? 'w-14' : ''}`}
          >
            <img src={preview} alt="" className={`size-full object-cover ${attachment.textPath ? 'w-14' : ''}`} />
          </button>
        ) : (
          <img src={preview} alt="" className={`size-9 shrink-0 rounded-lg object-cover ${attachment.textPath ? 'w-14' : ''}`} />
        )
      ) : (
        <>
          <span className="grid size-5 shrink-0 place-items-center">
            <FileTypeIcon name={attachment.name} isDir={false} size={16} />
          </span>
          <span className="min-w-0 max-w-[140px] truncate text-[11px] leading-none text-content/80">
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
              ? 'absolute -right-1 -top-1 size-5 bg-content/20 opacity-100 shadow-sm glass-surface glass-surface--sm'
              : 'size-4 text-content/40'
          }`}
        >
          <X className={image ? 'size-3' : 'size-3'} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  )
}
