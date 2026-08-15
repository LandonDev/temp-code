import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Archive,
  Blocks,
  GitFork,
  Settings as SettingsIcon,
  SlidersHorizontal,
  type LucideIcon
} from 'lucide-react'
import type { ProviderId } from '@shared/catalog'
import { useApp, type ThemePref } from '../../../state/store'
import { cn } from '../../../lib/utils'
import { SPRING_LAYOUT } from '../../../lib/ease'
import { ProviderMark, THREAD_GLYPHS, THREAD_TINTS, timeAgo } from '../bits'
import { ZIcon } from '../zicon'
import { Spinner } from '../../ui/spinner'
import { OrchestrationRulesEditor } from '../OrchestrationRules'
import { ThreadDefaultsEditor } from '../ThreadDefaults'
import { SettingsPanel, SettingsRow } from '../SettingsPanel'
import { EASE_OUT } from '../../../lib/ease'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

type SettingsPage = 'general' | 'defaults' | 'orchestration' | 'providers' | 'archived'

const PAGES: { id: SettingsPage; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon, hint: 'Appearance.' },
  {
    id: 'defaults',
    label: 'Defaults',
    icon: SlidersHorizontal,
    hint: 'What a new thread starts with. Workspaces can override from their sidebar menu.'
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
  const [page, setPage] = useState<SettingsPage>('general')
  const reduce = useReducedMotion()

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
              <button
                key={p.id}
                onClick={() => setPage(p.id)}
                className={cn(
                  'relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors active:scale-[0.99]',
                  page === p.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {page === p.id && (
                  <motion.span
                    layoutId="settings-page"
                    transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                    className="absolute inset-0 rounded-lg bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                  />
                )}
                <Icon className="relative size-4 shrink-0 opacity-75" strokeWidth={1.75} />
                <span className="relative">{p.label}</span>
              </button>
            )
          })}
        </div>
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
                </SettingsPanel>
              )}
              {page === 'defaults' && <ThreadDefaultsEditor workspaceId={null} />}
              {page === 'orchestration' && <OrchestrationRulesEditor workspaceId={null} />}
              {page === 'providers' && <ProviderHealthList />}
              {page === 'archived' && <ArchivedList />}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function PageHeader({ page }: { page: SettingsPage }): React.JSX.Element {
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0]
  return (
    <header className="pt-8">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{meta.label}</h2>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{meta.hint}</p>
    </header>
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
    <SettingsPanel>
      {archived.map((t) => {
        const Glyph = t.threadType ? THREAD_GLYPHS[t.threadType] : THREAD_GLYPHS.chat
        const project = projects.find((p) => p.id === t.projectId)
        return (
          <button
            key={t.id}
            onClick={() => void restore(t.id, t.projectId)}
            className="group/arch flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-accent/40"
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
    </SettingsPanel>
  )
}
