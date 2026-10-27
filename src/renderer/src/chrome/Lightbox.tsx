import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tip } from '../components/tip'
import { ChevronLeft, ChevronRight } from './icons'
import {
  closeLightbox,
  imageDataFor,
  lightboxSnapshot,
  stepLightbox,
  subscribeLightbox,
  type LightboxItem,
} from './lightboxStore'

// Every composer mounts a Lightbox; only the first one alive renders it,
// so split panes never stack two overlays.
const hosts: symbol[] = []
const hostSubs = new Set<() => void>()
const primaryHost = (): symbol | undefined => hosts[0]
function useIsPrimaryHost(): boolean {
  const [id] = useState(() => Symbol('lightbox-host'))
  useEffect(() => {
    hosts.push(id)
    hostSubs.forEach((f) => f())
    return () => {
      hosts.splice(hosts.indexOf(id), 1)
      hostSubs.forEach((f) => f())
    }
  }, [id])
  const primary = useSyncExternalStore((f) => {
    hostSubs.add(f)
    return () => hostSubs.delete(f)
  }, primaryHost)
  return primary === id
}

/** A slide is loading, failed, or the image's URL. */
type SlideState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; src: string }

function Slide({ item }: { item: LightboxItem }) {
  const [state, setState] = useState<SlideState>(item.src ? { kind: 'ready', src: item.src } : { kind: 'loading' })
  useEffect(() => {
    if (item.src) {
      setState({ kind: 'ready', src: item.src })
      return
    }
    if (!item.path) {
      setState({ kind: 'failed' })
      return
    }
    setState({ kind: 'loading' })
    let alive = true
    void imageDataFor(item.environmentId, item.path).then((url) => {
      if (alive) setState(url ? { kind: 'ready', src: url } : { kind: 'failed' })
    })
    return () => {
      alive = false
    }
  }, [item])
  if (state.kind === 'loading') {
    return (
      <p data-lightbox-state="loading" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading…
      </p>
    )
  }
  if (state.kind === 'failed') {
    return (
      <p data-lightbox-state="failed" className="text-sm text-muted-foreground">
        Couldn’t open {item.name}
      </p>
    )
  }
  return (
    <img
      src={state.src}
      alt={item.name}
      draggable={false}
      onError={() => setState({ kind: 'failed' })}
      className="max-h-[calc(100vh-112px)] max-w-[calc(100vw-160px)] select-none rounded-lg object-contain outline-1 -outline-offset-1 outline-foreground/10"
    />
  )
}

/**
 * Full-window image viewer on the Dialog primitive: the window less 24px a
 * side, no chrome but the close, the arrows and the counter. Escape and the
 * arrow keys reach it through the command map (lib/appCommands.ts); Base
 * UI's own Escape and a click away from the image close it too.
 */
export function Lightbox() {
  const snap = useSyncExternalStore(subscribeLightbox, lightboxSnapshot)
  const primary = useIsPrimaryHost()
  // The last open snapshot stays rendered while the exit plays.
  const last = useRef(snap)
  if (snap) last.current = snap
  const shown = snap ?? last.current

  if (!primary || !shown) return null
  const item = shown.items[shown.index]!
  const many = shown.items.length > 1
  return (
    <Dialog
      open={!!snap}
      onOpenChange={(open) => {
        if (!open) closeLightbox()
      }}
    >
      <DialogContent
        size="full"
        data-lightbox
        className="flex items-center justify-center p-0"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeLightbox()
        }}
      >
        <DialogTitle className="sr-only">{item.name}</DialogTitle>
        <div
          key={shown.index}
          className="flex items-center justify-center duration-(--dur-fast) ease-(--ease-out) animate-in fade-in-0"
        >
          <Slide item={item} />
        </div>
        {many ? (
          <>
            <Tip label="Previous" side="right">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous image"
                onClick={() => stepLightbox(-1)}
                className="absolute start-0 top-1/2 -translate-y-1/2"
              >
                <ChevronLeft className="size-5" />
              </Button>
            </Tip>
            <Tip label="Next" side="left">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next image"
                onClick={() => stepLightbox(1)}
                className="absolute end-0 top-1/2 -translate-y-1/2"
              >
                <ChevronRight className="size-5" />
              </Button>
            </Tip>
            <span className="absolute bottom-0 text-xs tabular-nums text-muted-foreground">
              {shown.index + 1} / {shown.items.length}
            </span>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
