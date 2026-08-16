import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'

/**
 * The destructive gate: a small focused modal — title states the action,
 * one line says what it actually destroys (and what survives), the
 * destructive button repeats the verb. Never used for reversible things.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => Promise<void> | void
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy && <Spinner className="size-3" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
