import { useState } from 'react'
import { GitBranch, GitPullRequestArrow } from 'lucide-react'
import type { ProjectMode, WorkspaceMeta } from '@shared/domain'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'

export function NewProjectDialog({
  workspace,
  onClose
}: {
  workspace: WorkspaceMeta
  onClose: () => void
}): React.JSX.Element {
  const createProject = useApp((s) => s.createProject)
  const selectProject = useApp((s) => s.selectProject)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ProjectMode>(workspace.git ? 'worktree' : 'local')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const project = await createProject(workspace.id, name.trim(), mode)
      selectProject(project.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const modes: { id: ProjectMode; label: string; hint: string; icon: React.JSX.Element; disabled?: boolean }[] = [
    {
      id: 'worktree',
      label: 'Worktree',
      hint: 'Own branch and folder, isolated from your checkout',
      icon: <GitPullRequestArrow className="size-4" />,
      disabled: !workspace.git
    },
    {
      id: 'local',
      label: 'Local',
      hint: `Work directly in ${workspace.name}`,
      icon: <GitBranch className="size-4" />
    }
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[15px]">New project in {workspace.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="What are you working on?"
          />
          <div className="flex gap-2">
            {modes.map((m) => (
              <button
                key={m.id}
                disabled={m.disabled}
                onClick={() => setMode(m.id)}
                className={cn(
                  'flex-1 rounded-lg border p-3 text-left transition-colors active:scale-[0.99]',
                  mode === m.id ? 'border-ring bg-accent/50' : 'hover:bg-accent/30',
                  m.disabled && 'cursor-not-allowed opacity-40'
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {m.icon}
                  {m.label}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{m.hint}</p>
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" disabled={!name.trim() || busy} onClick={() => void submit()}>
              {busy && <Spinner className="size-3.5" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
