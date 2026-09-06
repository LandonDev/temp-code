import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, CornerDownRight, GitBranch } from 'lucide-react'
import type { BranchList, ProjectMeta } from '@shared/domain'
import { TURN_PASS_OFF, passActions, type TurnPass } from '@shared/turnpass'
import type { BuildConfig } from '@shared/build'
import { client } from '../../lib/client'
import { useApp } from '../../state/store'
import { TurnPassFields } from './TurnPass'
import { BUILD_EMPTY, BuildFields, buildOrNull } from './BuildSettings'
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

const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

/** Edit a project after creation: name, the worktree's branch, and the
 *  completed-turn override. Everything applies on Save. */
export function ProjectSettingsDialog({
  project,
  onClose
}: {
  project: ProjectMeta
  onClose: () => void
}): React.JSX.Element {
  const renameProject = useApp((s) => s.renameProject)
  const refreshTree = useApp((s) => s.refreshTree)
  const fetchBranches = useApp((s) => s.fetchBranches)
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === project.workspaceId))

  const [name, setName] = useState(project.name)
  const [branches, setBranches] = useState<BranchList | null>(null)
  const [branch, setBranch] = useState(project.branch ?? '')
  const [baseRef, setBaseRef] = useState('@head')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Completed-turn: null = inherit the workspace setting. Editing the
  // fields writes an override; an all-off override runs nothing.
  const [override, setOverride] = useState<TurnPass | null>(null)
  const [savedOverride, setSavedOverride] = useState<TurnPass | null>(null)
  const [wsPass, setWsPass] = useState<TurnPass | null>(null)
  const [passOpen, setPassOpen] = useState(false)

  // Build: null = inherit (workspace setting, else detection).
  const [buildOverride, setBuildOverride] = useState<BuildConfig | null>(null)
  const [savedBuild, setSavedBuild] = useState<BuildConfig | null>(null)
  const [wsBuild, setWsBuild] = useState<BuildConfig | null>(null)
  const [detectedBuild, setDetectedBuild] = useState<BuildConfig | null>(null)
  const [buildOpen, setBuildOpen] = useState(false)

  const worktree = project.mode === 'worktree'

  useEffect(() => {
    if (worktree && workspace?.git) {
      void fetchBranches(workspace.id)
        .then(setBranches)
        .catch(() => {})
    }
  }, [worktree, workspace?.id, workspace?.git, fetchBranches])

  useEffect(() => {
    void client
      .request<TurnPass | null>('turnpass.get', {
        workspaceId: project.workspaceId,
        projectId: project.id
      })
      .then((p) => {
        setOverride(p)
        setSavedOverride(p)
      })
      .catch(() => {})
    void client
      .request<TurnPass | null>('turnpass.get', { workspaceId: project.workspaceId })
      .then(setWsPass)
      .catch(() => {})
    void client
      .request<BuildConfig | null>('build.get', {
        workspaceId: project.workspaceId,
        projectId: project.id
      })
      .then((c) => {
        setBuildOverride(c)
        setSavedBuild(c)
      })
      .catch(() => {})
    void client
      .request<BuildConfig | null>('build.get', { workspaceId: project.workspaceId })
      .then(setWsBuild)
      .catch(() => {})
    void client
      .request<BuildConfig | null>('build.detect', { path: project.cwd })
      .then(setDetectedBuild)
      .catch(() => {})
  }, [project.id, project.workspaceId, project.cwd])

  const trimmed = branch.trim()
  const exists = branchExists(branches, trimmed)
  const branchChanged = worktree && !!trimmed && trimmed !== project.branch
  const allRefs = useMemo(
    () => (branches ? [...branches.locals, ...branches.remotes] : []),
    [branches]
  )
  const suggestions = useMemo(() => {
    if (!branchChanged || exists) return []
    return allRefs.filter((r) => r.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 4)
  }, [branchChanged, trimmed, exists, allRefs])

  const effective = override ?? wsPass ?? TURN_PASS_OFF
  const passChanged =
    JSON.stringify(override) !== JSON.stringify(savedOverride)
  const effectiveBuild = buildOverride ?? wsBuild ?? BUILD_EMPTY
  const buildChanged =
    JSON.stringify(buildOrNull(buildOverride)) !== JSON.stringify(buildOrNull(savedBuild))
  const buildSummary = buildOrNull(buildOverride)
    ? buildOverride!.command.trim()
    : wsBuild
      ? `${wsBuild.command} · workspace`
      : detectedBuild
        ? `${detectedBuild.command} · detected`
        : 'None'
  const dirty = name.trim() !== project.name || branchChanged || passChanged || buildChanged

  const submit = async (): Promise<void> => {
    if (!dirty || busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (branchChanged) {
        await client.request('project.setBranch', {
          projectId: project.id,
          branch: trimmed,
          ...(!exists && baseRef !== '@head' ? { baseRef } : {})
        })
      }
      if (passChanged) {
        await client.request('turnpass.set', {
          workspaceId: project.workspaceId,
          projectId: project.id,
          pass: override
        })
      }
      if (buildChanged) {
        await client.request('build.set', {
          workspaceId: project.workspaceId,
          projectId: project.id,
          config: buildOrNull(buildOverride)
        })
      }
      if (name.trim() !== project.name) await renameProject(project.id, name.trim())
      else await refreshTree()
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
          <DialogTitle>Project settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          <p className="px-1 text-[11px] leading-4 text-muted-foreground">
            {worktree ? 'Worktree' : 'Local'} ·{' '}
            <span className="font-mono text-[10.5px]">{shortPath(project.cwd)}</span>
          </p>
          {worktree && (
            <div className="flex flex-col gap-1">
              <div className="relative">
                <GitBranch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="h-8 pl-8 font-mono text-[12px]"
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
              {branchChanged && (
                <div className="flex h-6 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <CornerDownRight className="size-3 shrink-0 opacity-60" />
                  {exists ? (
                    <span>Switches to the existing branch</span>
                  ) : (
                    <>
                      <span className="shrink-0">New branch from</span>
                      <Select value={baseRef} onValueChange={setBaseRef}>
                        <SelectTrigger size="sm" className="min-w-0 px-1.5">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="@head" className="text-[12px]">
                            Current HEAD ({project.branch})
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
                {passActions(effective).join(', ') || 'Off'}
                {override === null && ' · workspace'}
              </span>
            </button>
            {passOpen && (
              <div className="mt-1.5 flex flex-col gap-1">
                <TurnPassFields value={effective} onChange={setOverride} />
                {override !== null && (
                  <button
                    onClick={() => setOverride(null)}
                    className="self-start px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Use workspace setting
                  </button>
                )}
              </div>
            )}
          </div>
          <div>
            <button
              onClick={() => setBuildOpen(!buildOpen)}
              className="flex h-6 w-full items-center gap-1 px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn('size-3 shrink-0 transition-transform', buildOpen && 'rotate-90')}
              />
              <span>Build</span>
              <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground/70">
                {buildSummary}
              </span>
            </button>
            {buildOpen && (
              <div className="mt-1.5 flex flex-col gap-1">
                <BuildFields
                  value={effectiveBuild}
                  onChange={setBuildOverride}
                  detected={detectedBuild}
                  compact
                />
                {buildOverride !== null && (
                  <button
                    onClick={() => setBuildOverride(null)}
                    className="self-start px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Use workspace setting
                  </button>
                )}
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
            disabled={!dirty || !name.trim() || busy}
            onClick={() => void submit()}
          >
            {busy && <Spinner className="size-3" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
