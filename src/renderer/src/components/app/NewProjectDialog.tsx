import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, CornerDownRight, GitBranch, GitPullRequestArrow } from 'lucide-react'
import type { BranchList, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { TURN_PASS_OFF, passActions, type TurnPass } from '@shared/turnpass'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { TurnPassFields } from './TurnPass'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
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
  // Workspace's completed-turn setting shows as the default; editing it
  // here stores an override for just this project.
  const [pass, setPass] = useState<TurnPass>(TURN_PASS_OFF)
  const [passTouched, setPassTouched] = useState(false)
  const [passOpen, setPassOpen] = useState(false)

  useEffect(() => {
    if (!workspace.git) return
    void fetchBranches(workspace.id)
      .then(setBranches)
      .catch(() => {})
  }, [workspace.id, workspace.git, fetchBranches])

  useEffect(() => {
    void client
      .request<TurnPass | null>('turnpass.get', { workspaceId: workspace.id })
      .then((p) => setPass((cur) => (cur === TURN_PASS_OFF ? (p ?? TURN_PASS_OFF) : cur)))
      .catch(() => {})
  }, [workspace.id])

  const trimmed = branch.trim()
  const exists = branchExists(branches, trimmed)
  const allRefs = useMemo(
    () => (branches ? [...branches.locals, ...branches.remotes] : []),
    [branches]
  )
  const suggestions = useMemo(() => {
    if (!trimmed || exists) return []
    return allRefs.filter((r) => r.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 4)
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
      if (passTouched) {
        // An all-off override is real: this project runs nothing.
        await client.request('turnpass.set', { workspaceId: workspace.id, projectId: project.id, pass })
      }
      selectProject(project.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const modes: { id: ProjectMode; label: string; icon: React.JSX.Element; disabled?: boolean }[] = [
    {
      id: 'worktree',
      label: 'Worktree',
      icon: <GitPullRequestArrow className="size-3.5" />,
      disabled: !workspace.git
    },
    { id: 'local', label: 'Local', icon: <GitBranch className="size-3.5" /> }
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
          <div>
            <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted/60 p-0.5">
              {modes.map((m) => (
                <button
                  key={m.id}
                  disabled={m.disabled}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'flex h-7 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors',
                    mode === m.id
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-foreground/10'
                      : 'text-muted-foreground hover:text-foreground',
                    m.disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
                  )}
                >
                  {m.icon}
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 px-1 text-[11px] leading-4 text-muted-foreground">
              {mode === 'worktree'
                ? 'Own branch and folder, isolated from your checkout.'
                : `Works directly in ${workspace.name}.`}
            </p>
          </div>
          {mode === 'worktree' && workspace.git && (
            <div className="flex flex-col gap-1">
              <div className="relative">
                <GitBranch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="Branch (automatic)"
                  className="h-8 pl-8 font-mono text-[12px] placeholder:font-sans"
                  spellCheck={false}
                />
              </div>
              {suggestions.length > 0 && (
                <div className="flex flex-col">
                  {suggestions.map((r) => (
                    <button
                      key={r}
                      onClick={() => setBranch(r)}
                      className="rounded-md px-2 py-1 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
              {trimmed && (
                <div className="flex h-6 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <CornerDownRight className="size-3 shrink-0 opacity-60" />
                  {exists ? (
                    <span>Opens the existing branch</span>
                  ) : (
                    <>
                      <span className="shrink-0">New branch from</span>
                      <Select value={baseRef} onValueChange={setBaseRef}>
                        <SelectTrigger size="sm" className="min-w-0 px-1.5">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="@head" className="text-[12px]">
                            Current HEAD{branches?.current ? ` (${branches.current})` : ''}
                          </SelectItem>
                          {allRefs.map((r) => (
                            <SelectItem key={r} value={r} className="font-mono text-[12px]">
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div>
            <button
              onClick={() => setPassOpen(!passOpen)}
              className="flex h-6 w-full items-center gap-1 px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', passOpen && 'rotate-90')}
              />
              <span>Completed turn</span>
              <span className="ml-auto truncate text-muted-foreground/70">
                {passActions(pass).join(', ') || 'Off'}
              </span>
            </button>
            {passOpen && (
              <div className="mt-1.5">
                <TurnPassFields
                  value={pass}
                  onChange={(next) => {
                    setPass(next)
                    setPassTouched(true)
                  }}
                />
              </div>
            )}
          </div>
          {error && <p className="px-1 text-[11px] leading-4 text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            {busy && <Spinner className="size-3" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
