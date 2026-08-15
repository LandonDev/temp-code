import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { ProviderId } from '@shared/catalog'
import { useApp, type ThemePref } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { SPRING_LAYOUT } from '../../../lib/ease'
import { ProviderMark, THREAD_GLYPHS, THREAD_TINTS, timeAgo } from '../bits'
import { ZIcon } from '../zicon'
import { Spinner } from '../../ui/spinner'
import { OrchestrationRulesDialog } from '../OrchestrationRulesDialog'

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
      if (e.key === 'Escape') setSettingsOpen(false)
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
          title="Orchestration rules"
          hint="Conduct and routing policy fed into every orchestrator. Workspaces can override from their sidebar menu."
        >
          <RulesButton />
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

function RulesButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border/60 px-3 py-1.5 text-[13px] transition-colors hover:bg-accent/40 active:scale-[0.99]"
      >
        Edit rules
      </button>
      {open && <OrchestrationRulesDialog workspace={null} onClose={() => setOpen(false)} />}
    </>
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
