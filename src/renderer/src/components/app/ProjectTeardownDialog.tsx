import { useEffect, useState } from 'react'
import type { ProjectCleanup, ProjectMeta } from '@shared/domain'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Spinner } from '../ui/spinner'

/**
 * Archive/delete gate for projects. Worktree projects get checkboxes for
 * what to tear down in git; deleting the local branch needs the worktree
 * gone first (git refuses otherwise), so checking it locks the worktree
 * box on. Git failures land inline — the dialog stays up to retry.
 */
export function ProjectTeardownDialog({
  open,
  project,
  action,
  onConfirm,
  onClose
}: {
  open: boolean
  project: ProjectMeta
  action: 'archive' | 'delete'
  onConfirm: (cleanup: ProjectCleanup | undefined) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [worktree, setWorktree] = useState(false)
  const [localBranch, setLocalBranch] = useState(false)
  const [remoteBranch, setRemoteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setWorktree(false)
    setLocalBranch(false)
    setRemoteBranch(false)
    setError(null)
  }, [open])

  const git = project.mode === 'worktree'
  const any = worktree || localBranch || remoteBranch
  const cleanup = git && any ? { worktree: worktree || localBranch, localBranch, remoteBranch } : undefined

  const confirm = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(cleanup)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const body =
    action === 'delete'
      ? 'Its threads are deleted for good.'
      : 'The project leaves the sidebar. Its threads stay; restore it anytime.'

  const rows: { label: React.ReactNode; checked: boolean; locked?: boolean; set: (v: boolean) => void }[] = [
    {
      label: 'Remove the worktree folder',
      checked: worktree || localBranch,
      locked: localBranch,
      set: setWorktree
    },
    {
      label: (
        <>
          Delete branch <span className="font-mono text-[11px]">{project.branch}</span>
        </>
      ),
      checked: localBranch,
      set: setLocalBranch
    },
    {
      label: (
        <>
          Delete <span className="font-mono text-[11px]">origin/{project.branch}</span>
        </>
      ),
      checked: remoteBranch,
      set: setRemoteBranch
    }
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>
            {action === 'delete' ? 'Delete' : 'Archive'} {project.name}?
          </DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>

        {git && project.branch && (
          <div className="space-y-2 px-1">
            {rows.map((r, i) => (
              <label
                key={i}
                className={
                  'flex cursor-pointer items-center gap-2.5 text-xs ' +
                  (r.checked ? 'text-foreground' : 'text-muted-foreground')
                }
              >
                <Checkbox
                  checked={r.checked}
                  disabled={r.locked}
                  onCheckedChange={(v) => r.set(v === true)}
                />
                {r.label}
              </label>
            ))}
          </div>
        )}

        {error && (
          <p className="px-1 font-mono text-[11px] leading-4 break-words text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'delete' || any ? 'destructive' : 'default'}
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy && <Spinner className="size-3" />}
            {action === 'delete' ? 'Delete project' : 'Archive'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
