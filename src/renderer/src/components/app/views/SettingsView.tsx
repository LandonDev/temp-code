import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  Blocks,
  Coffee,
  Code,
  FolderGit2,
  GitFork,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type { ProviderId } from '@shared/catalog'
import type { LspStatusRow } from '@shared/domain'
import { client } from '../../../lib/client'
import { useApp, type ThemePref } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { SPRING_LAYOUT } from '../../../lib/ease'
import { ProviderMark, THREAD_GLYPHS, THREAD_TINTS, timeAgo } from '../bits'
import { ZIcon } from '../zicon'
import { Spinner } from '../../ui/spinner'
import { Switch } from '../../ui/switch'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { OrchestrationRulesEditor } from '../OrchestrationRules'
import { ThreadDefaultsEditor } from '../ThreadDefaults'
import { SettingsPanel, SettingsRow } from '../SettingsPanel'
import { ConfirmDialog } from '../ConfirmDialog'
import { Input } from '../../ui/input'
import { EASE_OUT } from '../../../lib/ease'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

type SettingsPage =
  'general' | 'defaults' | 'editor' | 'orchestration' | 'providers' | 'archived' | `ws:${string}`

const PAGES: { id: SettingsPage; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon, hint: 'Appearance.' },
  {
    id: 'defaults',
    label: 'Defaults',
    icon: SlidersHorizontal,
    hint: 'What a new thread starts with. Workspaces can override from their sidebar menu.'
  },
  {
    id: 'editor',
    label: 'Editor',
    icon: Code,
    hint: 'Language servers run per project, lazily, and stop when idle. Editing never depends on them.'
  },
  {
    id: 'orchestration',
    label: 'Orchestration',
    icon: GitFork,
    hint: 'How much the orchestrator may do itself, and which model handles which work.'
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: Blocks,
    hint: 'CLIs found on your PATH. Each runs under its own login.'
  },
  {
    id: 'archived',
    label: 'Archived',
    icon: Archive,
    hint: 'Hidden from the strip, never deleted. Sending into one revives it.'
  }
]

/** Settings, paged: a quiet nav column on the left, one page at a time on
 *  the right. Defaults and orchestration have per-workspace overrides,
 *  reached from each workspace's sidebar menu. */
export function SettingsView(): React.JSX.Element {
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)
  const settingsJump = useApp((s) => s.settingsJump)
  const clearSettingsJump = useApp((s) => s.clearSettingsJump)
  const workspaces = useApp((s) => s.workspaces)
  const [page, setPage] = useState<SettingsPage>('general')
  const reduce = useReducedMotion()

  // The sidebar can open settings straight onto a workspace's page —
  // consumed during render (prev-state pattern), cleared after.
  const [prevJump, setPrevJump] = useState<string | null>(null)
  if (settingsJump && settingsJump !== prevJump) {
    setPrevJump(settingsJump)
    setPage(settingsJump as SettingsPage)
  }
  useEffect(() => {
    if (settingsJump) clearSettingsJump()
  }, [settingsJump, clearSettingsJump])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A dialog or open menu owns Escape — only a bare Esc leaves settings.
      const overlayOpen = document.querySelector('[role="dialog"], [role="listbox"], [role="menu"]')
      if (e.key === 'Escape' && !overlayOpen) setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
      <nav className="w-48 shrink-0 px-4 pt-8">
        <div className="flex flex-col gap-px">
          {PAGES.map((p) => {
            const Icon = p.icon
            return (
              <NavRow
                key={p.id}
                active={page === p.id}
                onClick={() => setPage(p.id)}
                reduce={!!reduce}
              >
                <Icon className="relative size-4 shrink-0 opacity-75" strokeWidth={1.75} />
                <span className="relative truncate">{p.label}</span>
              </NavRow>
            )
          })}
        </div>
        {workspaces.length > 0 && (
          <>
            <p className="mt-5 mb-1 px-2.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/50 uppercase">
              Workspaces
            </p>
            <div className="flex flex-col gap-px">
              {workspaces.map((w) => (
                <NavRow
                  key={w.id}
                  active={page === `ws:${w.id}`}
                  onClick={() => setPage(`ws:${w.id}`)}
                  reduce={!!reduce}
                >
                  <FolderGit2 className="relative size-4 shrink-0 opacity-75" strokeWidth={1.75} />
                  <span className="relative truncate">{w.name}</span>
                </NavRow>
              ))}
            </div>
          </>
        )}
      </nav>

      <div className="min-h-0 w-full max-w-[560px] overflow-y-auto px-8 pb-16">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15, ease: EASE_OUT }}
          >
            <PageHeader page={page} />
            <div className="mt-5 flex flex-col gap-7 pb-4">
              {page === 'general' && (
                <SettingsPanel>
                  <SettingsRow label="Theme" description="System follows your OS appearance.">
                    <ThemeSwitch />
                  </SettingsRow>
                  <SettingsRow
                    label="While a turn runs"
                    description="Enter does this; ⌘Enter does the other."
                  >
                    <MidTurnSwitch />
                  </SettingsRow>
                </SettingsPanel>
              )}
              {page === 'defaults' && <ThreadDefaultsEditor workspaceId={null} />}
              {page === 'editor' && <EditorSettings />}
              {page === 'orchestration' && <OrchestrationRulesEditor workspaceId={null} />}
              {page === 'providers' && <ProviderHealthList />}
              {page === 'archived' && <ArchivedList />}
              {page.startsWith('ws:') && (
                <>
                  <ThreadDefaultsEditor workspaceId={page.slice(3)} />
                  <OrchestrationRulesEditor workspaceId={page.slice(3)} />
                </>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function PageHeader({ page }: { page: SettingsPage }): React.JSX.Element {
  const workspaces = useApp((s) => s.workspaces)
  if (page.startsWith('ws:')) {
    const ws = workspaces.find((w) => w.id === page.slice(3))
    return (
      <header className="pt-8">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{ws?.name ?? 'Workspace'}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          Overrides for this workspace. Anything untouched inherits the global settings.
        </p>
      </header>
    )
  }
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0]
  return (
    <header className="pt-8">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{meta.label}</h2>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{meta.hint}</p>
    </header>
  )
}

function NavRow({
  active,
  onClick,
  reduce,
  children
}: {
  active: boolean
  onClick: () => void
  reduce: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors active:scale-[0.99]',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {active && (
        <motion.span
          layoutId="settings-page"
          transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
          className="absolute inset-0 rounded-lg bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
        />
      )}
      {children}
    </button>
  )
}

function MidTurnSwitch(): React.JSX.Element {
  const value = useApp((s) => s.midTurnDefault)
  const setValue = useApp((s) => s.setMidTurnDefault)
  const reduce = useReducedMotion()
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
      {(['queue', 'steer'] as const).map((o) => (
        <button
          key={o}
          onClick={() => setValue(o)}
          className={cn(
            'relative rounded-md px-3 py-1 text-xs capitalize transition-colors',
            value === o ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {value === o && (
            <motion.span
              layoutId="mid-turn-pill"
              transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              className="absolute inset-0 rounded-md bg-background shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-accent"
            />
          )}
          <span className="relative">{o === 'queue' ? 'Queue' : 'Steer'}</span>
        </button>
      ))}
    </div>
  )
}

function ThemeSwitch(): React.JSX.Element {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const reduce = useReducedMotion()

  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          onClick={() => setTheme(o.value)}
          className={cn(
            'relative rounded-md px-3 py-1 text-xs transition-colors',
            theme === o.value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {theme === o.value && (
            <motion.span
              layoutId="theme-pill"
              transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              className="absolute inset-0 rounded-md bg-background shadow-[0_1px_3px_rgb(0_0_0/0.12)] dark:bg-accent"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

function ProviderHealthList(): React.JSX.Element {
  const catalog = useApp((s) => s.catalog)
  const doctor = useApp((s) => s.doctor)
  const fetchDoctor = useApp((s) => s.fetchDoctor)

  useEffect(() => {
    void fetchDoctor()
  }, [fetchDoctor])

  if (!catalog) return <Spinner className="size-4 text-muted-foreground/60" />

  return (
    <SettingsPanel>
      {Object.values(catalog).map((p) => {
        const health = doctor?.[p.id as ProviderId]
        return (
          <div key={p.id} className="flex items-center gap-3 px-4 py-3">
            <ProviderMark
              provider={p.id}
              size={16}
              className={cn(p.id !== 'claude' && 'text-foreground/80')}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{p.label}</span>
              {health?.path && (
                <span className="block truncate font-mono text-[10.5px] text-muted-foreground/60">
                  {health.path}
                </span>
              )}
            </span>
            {!health ? (
              <Spinner className="size-3.5 text-muted-foreground/50" />
            ) : health.found ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-success" />
                {health.version ?? 'Ready'}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-destructive" />
                Not found
              </span>
            )}
          </div>
        )
      })}
    </SettingsPanel>
  )
}

const fmtBytes = (n: number): string =>
  n > 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(n / 1024 / 1024)} MB`

function EditorSettings(): React.JSX.Element {
  const doctor = useApp((s) => s.doctor)
  const fetchDoctor = useApp((s) => s.fetchDoctor)
  const formatOnSave = useApp((s) => s.formatOnSave)
  const setFormatOnSave = useApp((s) => s.setFormatOnSave)
  const ghostText = useApp((s) => s.ghostText)
  const setGhostText = useApp((s) => s.setGhostText)
  const [servers, setServers] = useState<LspStatusRow[] | null>(null)
  const projects = useApp((s) => s.projects)

  useEffect(() => {
    void fetchDoctor()
    const load = (): void => {
      void client
        .request<LspStatusRow[]>('lsp.status')
        .then(setServers)
        .catch(() => setServers([]))
    }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [fetchDoctor])

  const java = doctor?.java

  return (
    <div className="flex flex-col gap-3">
      {/* the Java row, styled like the provider rows above it */}
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Coffee className="size-4 text-foreground/80" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Java</span>
            {java?.path && (
              <span className="block truncate font-mono text-[10.5px] text-muted-foreground/60">
                {java.path}
              </span>
            )}
          </span>
          {!java ? (
            <Spinner className="size-3.5 text-muted-foreground/50" />
          ) : java.error ? (
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={java.error}
            >
              <span className="size-1.5 rounded-full bg-destructive" />
              {java.found ? `JDK ${java.version} — needs 21+` : 'No JDK'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" />
              JDK {java.version}
              {java.jdtls ? ' · jdtls ready' : ' · jdtls downloads on first use'}
            </span>
          )}
        </div>
        {(servers ?? []).map((s) => {
          const project = projects.find((p) => p.id === s.projectId)
          return (
            <div
              key={s.serverId}
              className="flex items-center gap-2.5 border-t border-border/60 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {s.lang === 'java' ? 'jdtls' : s.lang === 'idea' ? 'IntelliJ engine' : 'vtsls'}
                <span className="ml-1.5 text-[11px] text-muted-foreground/60">
                  {project?.name ?? s.projectId}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {s.state === 'running'
                  ? `${s.memoryBytes ? fmtBytes(s.memoryBytes) : ''}${s.idleMs > 60_000 ? ` · idle ${Math.round(s.idleMs / 60_000)}m` : ''}`
                  : s.state}
              </span>
            </div>
          )
        })}
      </div>
      <IdeaEngineRow />
      <ToggleRow
        label="Format on save — Java"
        hint="jdtls (Eclipse formatter) runs on each autosave flush."
        checked={formatOnSave.java}
        onChange={(v) => setFormatOnSave('java', v)}
      />
      <ToggleRow
        label="Format on save — TypeScript"
        hint="The TS formatter runs on each autosave flush."
        checked={formatOnSave.web}
        onChange={(v) => setFormatOnSave('web', v)}
      />
      <ToggleRow
        label="AI ghost text"
        hint="Inline completions from Claude on your existing login. Debounced; LSP completion stays the workflow feature."
        checked={ghostText}
        onChange={setGhostText}
      />
    </div>
  )
}

/** The IntelliJ engine gate (docs/PLAN-4.md M15): preview build, EULA
 *  shown before first run, acceptance stored per build. */
function IdeaEngineRow(): React.JSX.Element {
  const doctor = useApp((s) => s.doctor)
  const fetchDoctor = useApp((s) => s.fetchDoctor)
  const [open, setOpen] = useState(false)
  const [eula, setEula] = useState<{ build: string; text: string } | null>(null)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idea = doctor?.java?.ideaServer

  const openGate = (): void => {
    setOpen(true)
    setError(null)
    if (!eula) {
      // First open downloads the dist to read its EULA — honest spinner.
      void client
        .request<{ build: string; text: string }>('idea.eula')
        .then(setEula)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    }
  }
  const accept = (): void => {
    void client
      .request('idea.acceptEula')
      .then(() => {
        setOpen(false)
        void fetchDoctor()
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">IntelliJ engine</span>
        <span className="block text-[11px] leading-snug text-muted-foreground">
          {idea?.accepted
            ? `IDEA-quality Java completions. Preview build ${idea.build}.`
            : 'JetBrains intellij-server: IDEA-quality completions. Preview; JetBrains EULA applies.'}
        </span>
      </span>
      {idea?.accepted ? (
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" />
          enabled
          <button
            onClick={() => {
              setUpdateMsg('checking…')
              void client
                .request<{ current: string; latest: string; updated: boolean }>('idea.checkUpdate')
                .then((r) => {
                  setUpdateMsg(
                    r.updated ? `updated to ${r.latest} — re-accept the EULA` : 'up to date'
                  )
                  void fetchDoctor()
                })
                .catch(() => setUpdateMsg('update check failed'))
            }}
            className="text-[11px] text-muted-foreground/70 underline-offset-2 hover:underline"
          >
            {updateMsg ?? 'check for updates'}
          </button>
        </span>
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openGate}>
          Enable…
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-sm">JetBrains EULA — intellij-server</DialogTitle>
          </DialogHeader>
          {error ? (
            <p className="text-[12px] text-destructive">{error}</p>
          ) : eula ? (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {eula.text}
            </pre>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Spinner className="size-3.5" /> Downloading the engine to read its license…
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={!eula} onClick={accept}>
              Accept and enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-[11px] text-muted-foreground/70">{hint}</span>
      </span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  )
}

/** Dialog titles stay one line — long thread names get elided. */
function clampTitle(t: string | undefined): string | undefined {
  if (!t) return t
  return t.length > 32 ? `${t.slice(0, 32).trimEnd()}…` : t
}

function ArchivedList(): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const selectProject = useApp((s) => s.selectProject)
  const setArchived = useApp((s) => s.setArchived)
  const deleteSession = useApp((s) => s.deleteSession)
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const archived = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.archived && !s.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )

  const q = query.trim().toLowerCase()
  const shown = q
    ? archived.filter((t) => {
        const project = projects.find((p) => p.id === t.projectId)
        return (
          t.title.toLowerCase().includes(q) ||
          (project?.name.toLowerCase().includes(q) ?? false) ||
          t.provider.includes(q)
        )
      })
    : archived

  if (archived.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/60 py-10 text-center">
        <ZIcon name="archive-minimalistic" size={22} className="text-muted-foreground/30" />
        <span className="text-xs text-muted-foreground/60">
          Nothing archived. Right-click a tab to archive it.
        </span>
      </div>
    )
  }

  // select() closes the settings page itself.
  const restore = async (id: string, projectId: string | null): Promise<void> => {
    await setArchived(id, false)
    if (projectId) selectProject(projectId)
    await select(id)
  }

  const confirmTarget = confirmId ? sessions[confirmId] : null

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${archived.length} archived…`}
          className="h-8 pl-8.5 text-[13px]"
        />
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-xs text-muted-foreground/60">
          {`Nothing matches "${query.trim()}".`}
        </div>
      ) : (
        <SettingsPanel>
          {shown.map((t) => {
            const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
            const project = projects.find((p) => p.id === t.projectId)
            return (
              <div
                key={t.id}
                className="group/arch flex w-full items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-accent/40"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/60">
                  <Glyph
                    className={cn('size-3.5 opacity-80', THREAD_TINTS[t.threadType ?? 'chat'])}
                  />
                </span>
                <button
                  onClick={() => void restore(t.id, t.projectId)}
                  className="min-w-0 flex-1 text-left"
                  title="Restore and open"
                >
                  <span className="block truncate text-[13px]">{t.title}</span>
                  <span className="mt-px flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                    <ProviderMark provider={t.provider} size={10} className="opacity-70" />
                    {project ? `${project.name} · ` : ''}
                    {timeAgo(t.updatedAt)}
                  </span>
                </button>
                <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/arch:opacity-100">
                  <button
                    onClick={() => void restore(t.id, t.projectId)}
                    className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95"
                  >
                    <ZIcon name="archive-up-minimalistic" size={13} />
                    Restore
                  </button>
                  <button
                    onClick={() => setConfirmId(t.id)}
                    aria-label="Delete thread"
                    title="Delete forever"
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive active:scale-95"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              </div>
            )
          })}
        </SettingsPanel>
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title={`Delete ${clampTitle(confirmTarget?.title) ?? 'thread'}?`}
        body="The thread and its whole transcript are gone for good."
        confirmLabel="Delete thread"
        onConfirm={() => (confirmId ? deleteSession(confirmId) : undefined)}
        onClose={() => setConfirmId(null)}
      />
    </div>
  )
}
