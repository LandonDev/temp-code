import { useState } from 'react'
import { TURN_PASS_OFF, passEnabled, type TurnPass } from '@shared/turnpass'
import { useApp } from '../../state/store'
import { client } from '../../lib/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { TurnPassFields } from './TurnPass'

/**
 * Follows the folder pick: names the workspace and sets its completed-turn
 * setting before anything runs in it. Both stay editable later from the
 * workspace's settings page.
 */
export function NewWorkspaceDialog({
  path,
  onClose
}: {
  path: string
  onClose: () => void
}): React.JSX.Element {
  const addWorkspace = useApp((s) => s.addWorkspace)
  const [pass, setPass] = useState<TurnPass>(TURN_PASS_OFF)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const ws = await addWorkspace(path)
      if (passEnabled(pass)) {
        await client.request('turnpass.set', { workspaceId: ws.id, pass })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add {path.split('/').pop() || path}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="px-1 text-[13px] font-medium">Completed turn</p>
            <p className="mt-0.5 px-1 text-[11px] leading-4 text-muted-foreground">
              What threads here do after each turn settles.
            </p>
            <div className="mt-2">
              <TurnPassFields value={pass} onChange={setPass} />
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} onClick={() => void submit()}>
              {busy && <Spinner className="size-3.5" />}
              Add workspace
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
