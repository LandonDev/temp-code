import { useEffect, useRef, useState } from 'react'
import { X } from './icons'
import {
  Attachment as AttachmentFrame,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger
} from '../components/ui/attachment'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { formatBytes } from '../lib/attachmentUpload'
import { attachmentPreviewSrc } from '../lib/attachments'
import type { Attachment } from '../lib/session'
import { FileTypeIcon } from './FileTypeIcon'
import { useNearViewport } from '../hooks/useNearViewport'
import { imageDataFor, openLightbox, type LightboxItem } from './lightboxStore'
import { lightboxChunk } from '../surfaces/chunks'

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
  /** An upload to the thread's host in flight (or failed): said in the chip's line. */
  progress?: { sent: number; total: number; failed?: boolean }
}

/** The chip's one line: the upload while it runs or failed, else the size. */
export function attachmentLine(attachment: Attachment, progress?: Props['progress']): string | null {
  if (progress?.failed) return 'Failed'
  if (progress) {
    const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
    return `Uploading ${percent}%`
  }
  return attachment.size > 0 ? formatBytes(attachment.size) : null
}

/** A file in the composer or on a sent message: the image or the file's
 *  glyph, its name, one line under it, and Remove while it can go. */
export function AttachmentChip({ environmentId, attachment, onRemove, onOpen, progress }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const preview = useAttachmentSrc(environmentId, attachment, useNearViewport(ref))
  const image = attachment.kind === 'image' && preview
  const line = attachmentLine(attachment, progress)
  const state = progress?.failed ? 'error' : progress ? 'uploading' : 'done'

  return (
    <AttachmentFrame
      ref={ref}
      size="sm"
      state={state}
      className="min-w-0 max-w-60"
      data-attachment-path={attachment.path}
      data-upload={progress ? (progress.failed ? 'failed' : String(progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0)) : undefined}
    >
      <AttachmentMedia variant={image ? 'image' : 'icon'}>
        {image ? <img src={preview} alt="" decoding="async" /> : <FileTypeIcon name={attachment.name} isDir={false} size={16} />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        {line ? <AttachmentDescription className="tabular-nums">{line}</AttachmentDescription> : null}
      </AttachmentContent>
      {/* An image always opens: the viewer reads it by path and says when it can't. */}
      {attachment.kind === 'image' && onOpen ? (
        <AttachmentTrigger {...lightboxChunk.intent} onClick={onOpen} aria-label={`Preview ${attachment.name}`} className="cursor-zoom-in" />
      ) : null}
      {onRemove ? (
        <AttachmentActions>
          <Tooltip>
            <TooltipTrigger
              render={
                <AttachmentAction
                  aria-label={`Remove ${attachment.name}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove()
                  }}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>Remove</TooltipContent>
          </Tooltip>
        </AttachmentActions>
      ) : null}
    </AttachmentFrame>
  )
}
