import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Coffee } from 'lucide-react'
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
import { OrchestrationRulesEditor } from '../OrchestrationRules'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

/** Settings: appearance, provider health, archived threads. */
export function SettingsView(): React.JSX.Element {
  const setSettingsOpen = useApp((s) => s.setSettingsOpen)

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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[560px] px-8 pt-8 pb-16">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Settings</h1>

        <Section title="Appearance" hint="How the app decides between light and dark.">
          <ThemeSwitch />
        </Section>

        <Section title="Providers" hint="CLIs found on your PATH. Each runs under its own login.">
          <ProviderHealthList />
        </Section>

        <Section
          title="Editor"
          hint="Language servers run per project, lazily, and stop when idle. Editing never depends on them."
        >
          <EditorSettings />
        </Section>

        <Section
          title="Orchestration"
          hint="How much the orchestrator may do itself, and which model handles which work. Workspaces can override from their sidebar menu."
        >
          <OrchestrationRulesEditor workspaceId={null} />
        </Section>

        <Section
          title="Archived threads"
          hint="Hidden from the strip, never deleted. Sending into one revives it."
        >
          <ArchivedList />
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-medium">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-3">{children}</div>
    </section>
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
    <div className="overflow-hidden rounded-lg border border-border/60">
      {Object.values(catalog).map((p, ix) => {
        const health = doctor?.[p.id as ProviderId]
        return (
          <div
            key={p.id}
            className={cn(
              'flex items-center gap-2.5 px-3 py-2.5',
              ix > 0 && 'border-t border-border/60'
            )}
          >
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
    </div>
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
                {s.lang === 'java' ? 'jdtls' : 'vtsls'}
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

function ArchivedList(): React.JSX.Element {
  const sessions = useApp((s) => s.sessions)
  const projects = useApp((s) => s.projects)
  const select = useApp((s) => s.select)
  const selectProject = useApp((s) => s.selectProject)
  const setArchived = useApp((s) => s.setArchived)

  const archived = Object.values(sessions)
    .filter((s) => s.archived && !s.parentId)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (archived.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 py-8 text-center">
        <ZIcon name="archive-minimalistic" size={22} className="text-muted-foreground/30" />
        <span className="text-xs text-muted-foreground/60">
          Nothing archived — right-click a tab to archive it.
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

  return (
    <div className="space-y-0.5">
      {archived.map((t) => {
        const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
        const project = projects.find((p) => p.id === t.projectId)
        return (
          <button
            key={t.id}
            onClick={() => void restore(t.id, t.projectId)}
            className="group/arch flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border">
              <Glyph className={cn('size-3.5 opacity-80', THREAD_TINTS[t.threadType ?? 'chat'])} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{t.title}</span>
              <span className="block text-[11px] text-muted-foreground/60">
                {project ? `${project.name} · ` : ''}
                {timeAgo(t.updatedAt)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/arch:opacity-100">
              <ZIcon name="archive-up-minimalistic" size={13} />
              Restore
            </span>
          </button>
        )
      })}
    </div>
  )
}
