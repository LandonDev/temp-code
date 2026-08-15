import { useEffect, useState } from 'react'
import { GitBranch, GitPullRequestArrow } from 'lucide-react'
import type { BranchList, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function NewProjectDialog({
  workspace,
  onClose
}: {
  workspace: WorkspaceMeta
  onClose: () => void
}): React.JSX.Element {
  const createProject = useApp((s) => s.createProject)
  const selectProject = useApp((s) => s.selectProject)
  const fetchBranches = useApp((s) => s.fetchBranches)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ProjectMode>(workspace.git ? 'worktree' : 'local')
  const [branches, setBranches] = useState<BranchList | null>(null)
  // Branch section (docs/PLAN-3.md M12): fork from a chosen ref, or adopt
  // an existing branch — "open my PR branch as a project".
  const [source, setSource] = useState<'head' | 'fork' | 'adopt'>('head')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspace.git) return
    void fetchBranches(workspace.id)
      .then(setBranches)
      .catch(() => {})
  }, [workspace.id, workspace.git, fetchBranches])

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const opts =
        mode === 'worktree' && source === 'fork' && ref
          ? { baseRef: ref }
          : mode === 'worktree' && source === 'adopt' && ref
            ? { existingBranch: ref }
            : {}
      const project = await createProject(workspace.id, name.trim(), mode, opts)
      selectProject(project.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const modes: {
    id: ProjectMode
    label: string
    hint: string
    icon: React.JSX.Element
    disabled?: boolean
  }[] = [
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

  const allRefs = branches ? [...branches.locals, ...branches.remotes] : []
  const sourceRows: { id: typeof source; label: string }[] = [
    { id: 'head', label: `Current HEAD${branches?.current ? ` (${branches.current})` : ''}` },
    { id: 'fork', label: 'Fork from…' },
    { id: 'adopt', label: 'Existing branch…' }
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New project in {workspace.name}</DialogTitle>
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
          {mode === 'worktree' && workspace.git && (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-1">
                {sourceRows.map((row) => (
                  <button
                    key={row.id}
                    onClick={() => {
                      setSource(row.id)
                      setRef('')
                    }}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] transition-colors',
                      source === row.id
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {row.label}
                  </button>
                ))}
              </div>
              {source !== 'head' && (
                <Select value={ref} onValueChange={setRef}>
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue
                      placeholder={
                        source === 'fork' ? 'Fork point (e.g. origin/main)' : 'Branch to open'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(source === 'fork'
                      ? allRefs
                      : allRefs.filter((r) => r !== branches?.current)
                    ).map((r) => (
                      <SelectItem key={r} value={r} className="text-[12px]">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!name.trim() || busy || (mode === 'worktree' && source !== 'head' && !ref)}
              onClick={() => void submit()}
            >
              {busy && <Spinner className="size-3.5" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
