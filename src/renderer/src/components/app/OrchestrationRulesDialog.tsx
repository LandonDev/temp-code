import { useEffect, useState } from 'react'
import type { WorkspaceMeta } from '@shared/domain'
import { client } from '../../lib/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Spinner } from '../ui/spinner'

interface Policy {
  text: string
  defaultText: string
}

/**
 * Editor for the orchestrator policy (conduct + routing rules) fed into
 * every orchestrator's system prompt. Global scope, or one workspace's
 * override layered on top of it.
 */
export function OrchestrationRulesDialog({
  workspace,
  onClose
}: {
  workspace: WorkspaceMeta | null
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [defaultText, setDefaultText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void client
      .request<Policy>('policy.get', { workspaceId: workspace?.id ?? null })
      .then((p) => {
        setText(p.text)
        setDefaultText(p.defaultText)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [workspace?.id])

  const save = async (): Promise<void> => {
    if (busy || text === null) return
    setBusy(true)
    setError(null)
    try {
      await client.request('policy.set', { workspaceId: workspace?.id ?? null, text })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {workspace ? `Orchestration rules · ${workspace.name}` : 'Orchestration rules'}
          </DialogTitle>
        </DialogHeader>
        {text === null && !error ? (
          <div className="flex h-72 items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Textarea
              autoFocus
              value={text ?? ''}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder={workspace ? 'Empty — the global rules apply as-is' : undefined}
              className="max-h-[60vh] min-h-72 resize-y font-mono text-xs leading-relaxed"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center justify-between">
              {workspace ? (
                <span className="text-[11px] text-muted-foreground">
                  Layered on top of the global rules
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setText(defaultText)}>
                  Restore defaults
                </Button>
              )}
              <Button size="sm" disabled={busy || text === null} onClick={() => void save()}>
                {busy && <Spinner className="size-3.5" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
