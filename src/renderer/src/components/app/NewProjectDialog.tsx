import { useEffect, useMemo, useState } from 'react'
import { GitBranch, GitPullRequestArrow } from 'lucide-react'
import type { BranchList, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { useApp } from '../../state/store'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** A typed branch matches an existing one when it's a local head or an
 *  origin remote (with or without the origin/ prefix). */
function branchExists(list: BranchList | null, name: string): boolean {
  if (!list) return false
  const local = name.replace(/^origin\//, '')
  return (
    list.locals.includes(local) ||
    list.remotes.includes(name) ||
    list.remotes.includes(`origin/${local}`)
  )
}

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
  // Target branch for the worktree: empty = auto (tc/<slug>), an existing
  // name opens that branch, a new name gets created from the chosen base.
  const [branch, setBranch] = useState('')
  const [baseRef, setBaseRef] = useState('@head')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspace.git) return
    void fetchBranches(workspace.id)
      .then(setBranches)
      .catch(() => {})
  }, [workspace.id, workspace.git, fetchBranches])

  const trimmed = branch.trim()
  const exists = branchExists(branches, trimmed)
  const allRefs = useMemo(
    () => (branches ? [...branches.locals, ...branches.remotes] : []),
    [branches]
  )
  const suggestions = useMemo(() => {
    if (!trimmed || exists) return []
    return allRefs.filter((r) => r.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 5)
  }, [trimmed, exists, allRefs])

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const opts =
        mode === 'worktree' && trimmed
          ? {
              branch: trimmed,
              ...(!exists && baseRef !== '@head' ? { baseRef } : {})
            }
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
              <Input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Branch (empty = new tc/… branch)"
                className="h-8 text-[12px]"
                spellCheck={false}
              />
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {suggestions.map((r) => (
                    <button
                      key={r}
                      onClick={() => setBranch(r)}
                      className="rounded-md bg-accent/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
              {trimmed &&
                (exists ? (
                  <p className="text-[11px] text-muted-foreground">
                    Opens the existing <span className="font-mono">{trimmed}</span> branch.
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      New branch, created from
                    </span>
                    <Select value={baseRef} onValueChange={setBaseRef}>
                      <SelectTrigger className="h-7 flex-1 text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="@head" className="text-[12px]">
                          Current HEAD{branches?.current ? ` (${branches.current})` : ''}
                        </SelectItem>
                        {allRefs.map((r) => (
                          <SelectItem key={r} value={r} className="text-[12px]">
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
            </div>
          )}
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
