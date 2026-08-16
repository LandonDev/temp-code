import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn, displayPath } from '../../../lib/utils'
import { commandPhrases, humanizeCommand, pastPhrase, stripShell } from '../../../lib/humanize'
import { useApp } from '../../../state/store'
import { ZIcon, type ZIconName } from '../zicon'
import { duration } from '../bits'
import { MatrixSpinner } from '../WorkingStrip'
import { TextShimmer } from '../../motion/text-shimmer'
import type { Block } from '../../../state/blocks'

type ToolBlock = Extract<Block, { kind: 'tool' }>

/**
 * Zeron tool rendering (transcript.rs + proto/view.rs, values verbatim):
 * consecutive tool parts fold into ONE group row — a collapsed summary
 * sentence that expands to chip cards along a guide rail. Rows stay
 * collapsed while the turn streams (a label shimmer is the live signal);
 * only the user's toggle expands them.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const input = (b: ToolBlock): Record<string, unknown> =>
  b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {}

// eslint-disable-next-line no-control-regex -- ESC is the point: strip ANSI color codes
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

/** Zeron chip categories (proto/view.rs ToolKind). */
type Kind =
  | 'run'
  | 'read'
  | 'write'
  | 'edit'
  | 'patch'
  | 'search'
  | 'glob'
  | 'fetch'
  | 'web'
  | 'todo'
  | 'mcp'
  | 'tool'

function kindOf(b: ToolBlock): Kind {
  switch (b.name) {
    case 'Bash':
    case 'shell':
    case 'Shell':
      return 'run'
    case 'Read':
      return 'read'
    case 'Write':
      return 'write'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'apply_patch':
      return 'patch'
    case 'Grep':
      return 'search'
    case 'Glob':
      return 'glob'
    case 'WebFetch':
      return 'fetch'
    case 'WebSearch':
    case 'web_search':
      return 'web'
    case 'TodoWrite':
    case 'update_plan':
      return 'todo'
    default:
      return b.name.includes('.') || b.name.startsWith('mcp__') ? 'mcp' : 'tool'
  }
}

/** "mcp__orchestrator__spawn_agent" → "spawn_agent"; other names verbatim. */
function shortName(name: string): string {
  if (name.startsWith('mcp__')) return name.split('__').at(-1) ?? name
  if (name.includes('.')) return name.split('.').at(-1) ?? name
  return name
}

/** Tool wall clock, call → result; undefined until it lands or if < 1s. */
function toolMs(b: ToolBlock): number | undefined {
  if (b.ts === undefined || b.doneTs === undefined) return undefined
  const ms = b.doneTs - b.ts
  return ms >= 1000 ? ms : undefined
}

/** Verb label + Solar icon per kind (proto/view.rs chip labels). */
const CHIP: Record<Kind, { label: string; icon: ZIconName }> = {
  run: { label: 'Run', icon: 'command' },
  read: { label: 'Read', icon: 'document' },
  write: { label: 'Write', icon: 'document-add' },
  edit: { label: 'Edit', icon: 'pen' },
  patch: { label: 'Patch', icon: 'document' },
  search: { label: 'Search', icon: 'magnifer' },
  glob: { label: 'Glob', icon: 'folder-with-files' },
  fetch: { label: 'Fetch', icon: 'global' },
  web: { label: 'Web', icon: 'global' },
  todo: { label: 'Todo', icon: 'checklist' },
  mcp: { label: 'MCP', icon: 'widget' },
  tool: { label: 'Tool', icon: 'widget' }
}

function pathOf(b: ToolBlock): string {
  const i = input(b)
  return str(i.file_path) || str(i.path) || str(i.notebook_path)
}

/** One-line detail: the command, the path, `pattern in path`, the URL,
 *  `2/5 done`, `server · tool`. Newlines collapse to spaces. */
function detailOf(b: ToolBlock, cwd?: string): string {
  const i = input(b)
  const p = (s: string): string => (s ? displayPath(s, cwd) : '')
  switch (kindOf(b)) {
    // Run rows read as intent, not shell: the harness's own description when
    // it sent one (claude's Bash does), a derived phrase otherwise. The raw
    // command lives in the expansion and the hover title.
    case 'run':
      return str(i.description) || humanizeCommand(str(i.command))
    case 'read':
    case 'write':
    case 'edit':
      return p(pathOf(b))
    case 'patch': {
      const paths = Array.isArray(b.input)
        ? (b.input as Record<string, unknown>[]).map((c) => str(c.path)).filter(Boolean)
        : Object.keys(i)
      return paths.map((x) => p(x)).join(', ')
    }
    case 'search': {
      const where = p(str(i.path))
      return where ? `${str(i.pattern)} in ${where}` : str(i.pattern)
    }
    case 'glob':
      return str(i.pattern)
    case 'fetch':
      return str(i.url)
    case 'web':
      return str(i.query)
    case 'todo': {
      const raw = (i.todos ?? i.plan) as { status?: string }[] | undefined
      if (Array.isArray(raw)) {
        const done = raw.filter((t) => t.status === 'completed').length
        return `${done}/${raw.length} done`
      }
      return ''
    }
    // mcp + unknown tools: the first string input is usually the payload
    // (a task, a message, an id) — far more telling than the server name.
    default: {
      const firstString = Object.values(i).find((v) => typeof v === 'string')
      return str(firstString).replace(/\s*\n\s*/g, ' ')
    }
  }
}

const trim = (s: string, n = 32): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** App bookkeeping lives under .temp-code/ — journal, plans, mirrors. */
export const isInternalPath = (p: string): boolean => /(^|\/)\.temp-code(\/|$)/.test(p)

/** Every file an edit-tool call touches (apply_patch may carry several). */
function editPaths(b: ToolBlock): string[] {
  if (b.name === 'apply_patch') {
    return Array.isArray(b.input)
      ? (b.input as Record<string, unknown>[]).map((c) => str(c.path)).filter(Boolean)
      : []
  }
  const p = pathOf(b)
  return p ? [p] : []
}

/** What a .temp-code edit means in app terms. */
function memoryLabel(paths: string[]): string {
  if (paths.some((p) => p.endsWith('PROJECT.md'))) return 'project memory'
  if (paths.some((p) => /plan-[\w-]+\.md$/.test(p))) return 'the plan'
  if (paths.some((p) => p.includes('.temp-code/threads/'))) return 'thread notes'
  return 'app files'
}

/**
 * Split an edit-tool call for display: one standalone card per real file
 * (never collapsed behind "+N more"), and the app-bookkeeping remainder as
 * a quiet grouped block ("Updated project memory") — those aren't the
 * user's files, so they don't get a file card.
 */
export function splitEdit(b: ToolBlock): { edits: ToolBlock[]; internal: ToolBlock | null } {
  if (b.name === 'apply_patch' && Array.isArray(b.input) && b.input.length > 0) {
    const changes = b.input as Record<string, unknown>[]
    const real = changes.filter((c) => !isInternalPath(str(c.path)))
    const internal = changes.filter((c) => isInternalPath(str(c.path)))
    return {
      edits: real.map((c, n) => ({
        ...b,
        id: `${b.id}e${n}`,
        callId: `${b.callId}#${str(c.path)}`,
        input: [c]
      })),
      internal: internal.length
        ? { ...b, id: `${b.id}m`, callId: `${b.callId}#memory`, input: internal }
        : null
    }
  }
  return isInternalPath(pathOf(b)) ? { edits: [], internal: b } : { edits: [b], internal: null }
}

/** Thread titles for resolving ids in app-tool rows; ids never render. */
type ThreadTitles = Record<string, { title: string } | undefined>

/** In-house app_* tools render as what they DO. The raw input stays one
 *  click away in the expansion, like every other tool. */
function appView(
  b: ToolBlock,
  titles: ThreadTitles
): { label: string; detail: string; phrase: string } | null {
  const i = input(b)
  // Edits that only touch app bookkeeping read as what they mean, not as
  // file edits ("Updated project memory"). Real-file edits never come
  // through here — splitEdit routes them to their own cards.
  if (EDIT_TOOLS.has(b.name)) {
    const paths = editPaths(b)
    if (paths.length && paths.every(isInternalPath)) {
      const what = memoryLabel(paths)
      return { label: 'Updated', detail: what, phrase: `updated ${what}` }
    }
    return null
  }
  switch (shortName(b.name)) {
    case 'app_list_threads':
      return {
        label: 'Threads',
        detail: i.allProjects ? 'all projects' : 'this project',
        phrase: 'listed the threads'
      }
    case 'app_read_thread': {
      const title = titles[str(i.threadId)]?.title
      return {
        label: 'Read thread',
        detail: title ?? '',
        phrase: title ? `read thread “${trim(title, 24)}”` : 'read a thread'
      }
    }
    case 'app_start_thread': {
      // The created thread names itself in the result; the input may too.
      let title = str(i.title)
      if (!title && b.output) {
        try {
          title = str((JSON.parse(b.output) as { title?: string }).title)
        } catch {
          // non-JSON output = a refusal string; the type alone is the detail
        }
      }
      const type = str(i.threadType)
      return {
        label: 'New thread',
        detail: [title, type].filter(Boolean).join(' · '),
        phrase: title ? `started “${trim(title, 24)}”` : `started a ${type || 'thread'}`
      }
    }
    default:
      return null
  }
}

/** What one tool did, past tense, lowercase ("checked git status"). */
function toolPhrases(t: ToolBlock, titles: ThreadTitles): string[] {
  const app = appView(t, titles)
  if (app) return [app.phrase]
  const i = input(t)
  const file = (): string => pathOf(t).split('/').pop() ?? ''
  switch (kindOf(t)) {
    case 'run': {
      const desc = str(i.description)
      if (desc) return [pastPhrase(desc.charAt(0).toLowerCase() + desc.slice(1))]
      return commandPhrases(str(i.command)).map(pastPhrase)
    }
    case 'read':
      return [`read ${file()}`]
    // write/edit/patch never reach groups — splitEdit gives them cards,
    // and internal-only ones take the appView memory phrase above.
    case 'search':
    case 'glob':
      return [`searched for ${trim(str(i.pattern), 20)}`]
    case 'fetch':
      try {
        return [`fetched ${new URL(str(i.url)).hostname}`]
      } catch {
        return ['fetched a page']
      }
    case 'web':
      return [`searched the web for ${trim(str(i.query), 20)}`]
    case 'todo':
      return ['updated todos']
    // mcp/unknown tool names keep their own casing.
    default:
      return [shortName(t.name)]
  }
}

/** The group summary: the first two distinct things that happened, then a
 *  count — "Checked git status · read pom.xml +3 more · 1 failed". */
export function groupSummary(tools: ToolBlock[], titles: ThreadTitles = {}): string {
  const phrases: string[] = []
  let failed = 0
  let namedFirst = false
  for (const t of tools) {
    if (t.isError) failed++
    for (const p of toolPhrases(t, titles)) {
      if (p && !phrases.includes(p)) {
        // A leading bare tool name keeps its own casing — never sentence-cased.
        if (phrases.length === 0 && p === shortName(t.name)) namedFirst = true
        phrases.push(p)
      }
    }
  }
  const extra = phrases.length - 2
  let joined =
    phrases
      .slice(0, 2)
      .map((p) => trim(p))
      .join(' · ') || `${tools.length} tools`
  if (extra > 0) joined += ` +${extra} more`
  if (failed) joined += ` · ${failed} failed`
  return namedFirst ? joined : joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** Expansion state survives virtualization — rows scrolled out of the
 *  overscan window unmount, and a section the user opened must still be
 *  open when they scroll back. Keyed by callId (harness-unique). */
const openState = new Map<string, boolean>()
function usePersistedOpen(key: string, def = false): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(openState.get(key) ?? def)
  const set = (v: boolean): void => {
    openState.set(key, v)
    setOpen(v)
  }
  return [open, set]
}

/** Tween a displayed count toward its target — the diffstat counts up as
 *  the change lands instead of teleporting. 550ms ease-out cubic. The tween
 *  restarts from the value on screen, so a target that keeps moving (input
 *  still streaming) reads as one continuous count. */
function useCountUp(target: number, animate: boolean): number {
  const [v, setV] = useState(0)
  const cur = useRef(0)
  const raf = useRef(0)
  useEffect(() => {
    if (!animate || cur.current === target) return
    const start = cur.current
    const t0 = performance.now()
    const tick = (now: number): void => {
      // rAF timestamps are frame-start times and can predate t0 — clamp low.
      const p = Math.min(1, Math.max(0, (now - t0) / 550))
      const eased = 1 - Math.pow(1 - p, 3)
      cur.current = Math.round(start + (target - start) * eased)
      setV(cur.current)
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, animate])
  return animate ? v : target
}

/** 18px chevron tile — rounded 5, white/6% plate, ▸ → ▾ via a 200ms rotate. */
function ChevronTile({ open }: { open: boolean }): React.JSX.Element {
  return (
    <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-(--tile) text-muted-foreground/70">
      <ZIcon
        name="alt-arrow-right"
        size={10}
        className={cn('transition-transform duration-200', open && 'rotate-90')}
      />
    </span>
  )
}

/** Height tween wrapper: 200ms ease-out on user toggles ONLY — auto-open,
 *  streaming growth and remounts render at final size with no animation. */
function TweenHeight({
  open,
  animate,
  children
}: {
  open: boolean
  animate: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (first.current || !animate) {
      first.current = false
      el.style.transition = 'none'
      el.style.height = open ? 'auto' : '0px'
      return
    }
    const target = open ? el.scrollHeight : 0
    const from = open ? 0 : el.scrollHeight
    el.style.transition = 'none'
    el.style.height = `${from}px`
    // Force the start frame, then tween to the target (RESIZE: 200ms ease-out).
    void el.offsetHeight
    el.style.transition = 'height 200ms ease-out'
    el.style.height = `${target}px`
    const done = (): void => {
      el.style.transition = 'none'
      if (open) el.style.height = 'auto'
      el.removeEventListener('transitionend', done)
    }
    el.addEventListener('transitionend', done)
    return () => el.removeEventListener('transitionend', done)
  }, [open, animate])
  return (
    <div ref={ref} className="overflow-hidden" style={{ height: open ? 'auto' : 0 }}>
      {children}
    </div>
  )
}

const OUTPUT_LINE_CAP = 24
const DIFF_LINE_CAP = 600

/** Output block: mono 11.5px / 18px lines, py 6 px 12, verbatim
 *  indentation, capped at 24 lines with a faint "… N more lines" tail. */
function OutputBlock({ text, error }: { text: string; error?: boolean }): React.JSX.Element {
  const all = stripAnsi(text).replace(/\n+$/, '').split('\n')
  const shown = all.slice(0, OUTPUT_LINE_CAP)
  const more = all.length - shown.length
  return (
    <div className="px-3 py-1.5">
      <pre
        className={cn(
          'font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere]',
          error ? 'text-destructive' : 'text-foreground/85'
        )}
      >
        {shown.join('\n') || '(no output)'}
      </pre>
      {more > 0 && (
        <div className="text-[10.5px] leading-[18px] text-faint">… {more} more lines</div>
      )}
    </div>
  )
}

/** Diff hunks — emerald adds / red deletes, capped at 600 lines. */
function DiffBlock({ b }: { b: ToolBlock }): React.JSX.Element {
  const hunks = editModel(b).hunks
  const capped: { old: string[]; new: string[] }[] = []
  let budget = DIFF_LINE_CAP
  for (const h of hunks) {
    if (budget <= 0) break
    const oldShown = h.old.slice(0, budget)
    budget -= oldShown.length
    const newShown = h.new.slice(0, Math.max(0, budget))
    budget -= newShown.length
    capped.push({ old: oldShown, new: newShown })
  }
  return (
    <div className="py-1.5 font-mono text-[11.5px] leading-[18px]">
      {capped.map((h, n) => (
        <div key={n} className={cn(n > 0 && 'mt-1.5 border-t border-(--hairline) pt-1.5')}>
          {h.old.map((l, j) => (
            <div
              key={`o${j}`}
              className="bg-destructive/10 px-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-destructive"
            >
              − {l || ' '}
            </div>
          ))}
          {h.new.map((l, j) => (
            <div
              key={`n${j}`}
              className="bg-success/10 px-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-success"
            >
              + {l || ' '}
            </div>
          ))}
        </div>
      ))}
      {budget <= 0 && <div className="px-3 text-[10.5px] text-faint">… diff truncated</div>}
    </div>
  )
}

/** The invocation, pretty: the command without its shell wrapper, the
 *  pattern, the URL — never raw JSON (PrettyJson covers structured input). */
function invocationBody(b: ToolBlock): string {
  const i = input(b)
  switch (kindOf(b)) {
    case 'run':
      return stripShell(str(i.command))
    case 'search':
      return [str(i.pattern), str(i.path) && `in ${str(i.path)}`].filter(Boolean).join(' ')
    case 'glob':
      return str(i.pattern)
    case 'fetch':
      return str(i.url)
    case 'web':
      return str(i.query)
    default:
      return pathOf(b)
  }
}

/** JSON payload → structured view fodder; undefined when it isn't JSON. */
function parseJson(text: string): unknown {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

const scalar = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : v === null
      ? '—'
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)

/** Key/value rows — the pretty face of any JSON object. Thread ids keep
 *  resolving to titles here too. */
function KVRows({
  obj,
  titles
}: {
  obj: Record<string, unknown>
  titles: ThreadTitles
}): React.JSX.Element {
  return (
    <div className="space-y-px">
      {Object.entries(obj).map(([k, v]) => {
        const title =
          /threadid|sessionid/i.test(k) && typeof v === 'string' ? titles[v]?.title : undefined
        return (
          <div key={k} className="flex gap-2 text-[11.5px] leading-[18px]">
            <span className="w-24 shrink-0 truncate text-faint">{k}</span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground/85">
              {title ?? scalar(v)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const PRETTY_ROW_CAP = 12

function PrettyJson({
  value,
  titles
}: {
  value: unknown
  titles: ThreadTitles
}): React.JSX.Element {
  if (Array.isArray(value)) {
    const shown = value.slice(0, PRETTY_ROW_CAP)
    return (
      <div>
        {shown.map((v, n) => (
          <div key={n} className={cn(n > 0 && 'mt-1 border-t border-(--hairline) pt-1')}>
            {v && typeof v === 'object' ? (
              <KVRows obj={v as Record<string, unknown>} titles={titles} />
            ) : (
              <div className="text-[11.5px] leading-[18px] text-foreground/85">{scalar(v)}</div>
            )}
          </div>
        ))}
        {value.length > shown.length && (
          <div className="pt-1 text-[10.5px] text-faint">… {value.length - shown.length} more</div>
        )}
      </div>
    )
  }
  if (value && typeof value === 'object') {
    return <KVRows obj={value as Record<string, unknown>} titles={titles} />
  }
  return <div className="text-[11.5px] leading-[18px] text-foreground/85">{scalar(value)}</div>
}

/**
 * The expansion body every tool row shares: what was asked, then what came
 * back — pretty by default (wrapper-free command, key/value JSON), verbatim
 * behind one small `raw` toggle in the corner.
 */
const ToolDetails = memo(function ToolDetails({ b }: { b: ToolBlock }): React.JSX.Element {
  const [raw, setRaw] = usePersistedOpen(`raw:${b.callId}`)
  const sessions = useApp((s) => s.sessions)
  const k = kindOf(b)
  if (k === 'todo') return <TodoBlock b={b} />

  const structuredIn = k === 'mcp' || k === 'tool' || k === 'patch'
  const parsedOut = !raw && b.output !== undefined && !b.isError ? parseJson(b.output) : undefined

  return (
    <div className="relative">
      <button
        onClick={() => setRaw(!raw)}
        title={raw ? 'Formatted view' : 'Verbatim invocation and output'}
        className="absolute top-1.5 right-2 z-10 text-[10px] font-medium text-faint transition-colors duration-150 hover:text-foreground"
      >
        {raw ? 'pretty' : 'raw'}
      </button>
      <div className="px-3 py-1.5 pr-12">
        {raw ? (
          <pre className="font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
            {k === 'run' ? str(input(b).command) : JSON.stringify(b.input ?? {}, null, 2)}
          </pre>
        ) : structuredIn ? (
          <PrettyJson value={b.input ?? {}} titles={sessions} />
        ) : (
          <pre className="font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
            {invocationBody(b)}
          </pre>
        )}
      </div>
      {b.output !== undefined && (
        <div className="border-t border-(--hairline)">
          {parsedOut !== undefined ? (
            <div className="px-3 py-1.5">
              <PrettyJson value={parsedOut} titles={sessions} />
            </div>
          ) : (
            <OutputBlock text={b.output} error={b.isError} />
          )}
        </div>
      )}
    </div>
  )
})

function TodoBlock({ b }: { b: ToolBlock }): React.JSX.Element {
  const i = input(b)
  const raw = (i.todos ?? i.plan) as { content?: string; step?: string; status?: string }[]
  const items = Array.isArray(raw) ? raw : []
  return (
    <div className="space-y-0.5 px-3 py-1.5">
      {items.map((t, n) => (
        <div
          key={n}
          className={cn(
            'flex items-start gap-2 text-[11.5px] leading-[18px]',
            t.status === 'completed' ? 'text-muted-foreground' : 'text-foreground/85'
          )}
        >
          <span className="w-3 shrink-0 text-center text-faint">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : '·'}
          </span>
          {t.content ?? t.step ?? ''}
        </div>
      ))}
    </div>
  )
}

/** One chip: a 30px card that grows in place when expanded — invocation
 *  first, then output/diff, stacked under white/6% hairlines. */
const Chip = memo(function Chip({ b }: { b: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = usePersistedOpen(b.callId)
  const [userToggled, setUserToggled] = useState(false)
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const sessions = useApp((s) => s.sessions)
  const k = kindOf(b)
  const chip = CHIP[k]
  const app = appView(b, sessions)
  const detail = app?.detail ?? detailOf(b, projectCwd)
  const running = b.output === undefined
  // The driver announces a call before its input finishes streaming — until
  // the complete input lands the chip is a spinner, never a half-filled row
  // (edit cards use the partial input; small chips would just flicker).
  const loading = b.input === undefined || b.partialInput === true
  const [wasLoading] = useState(loading)

  return (
    <div className="pt-0.5">
      <div className="rounded-[9px] border border-(--chip-border) bg-(--chip-bg)">
        <button
          onClick={() => {
            setUserToggled(true)
            setOpen(!open)
          }}
          className="flex h-[30px] w-full items-center gap-2 px-2 text-left text-xs"
        >
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-(--tile-strong) text-muted-foreground">
            {loading ? <MatrixSpinner cell={2} /> : <ZIcon name={chip.icon} size={12} />}
          </span>
          <span
            className={cn(
              'shrink-0 font-medium',
              b.isError ? 'text-destructive' : loading ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {app?.label ?? (k === 'mcp' || k === 'tool' ? shortName(b.name) : chip.label)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              b.isError ? 'text-destructive' : 'text-foreground/85',
              wasLoading && !loading && 'animate-[z-fade-quick_150ms_ease-out]'
            )}
          >
            {loading ? '' : running ? <TextShimmer>{detail}</TextShimmer> : detail}
          </span>
          {toolMs(b) !== undefined && (
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/60">
              {duration(toolMs(b)!)}
            </span>
          )}
          {running && !loading && (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-busy" />
          )}
          <ChevronTile open={open} />
        </button>
        <TweenHeight open={open} animate={userToggled}>
          <div className="border-t border-(--hairline)">
            <ToolDetails b={b} />
          </div>
        </TweenHeight>
      </div>
    </div>
  )
})

/** The folded group row — collapsed while it works (a shimmer on the label
 *  is the live signal, never an auto-opened dump); the user's toggle is the
 *  only thing that expands it.
 *
 *  A single tool skips the generic summary ("Called 1 tool") entirely: the
 *  header IS the verb + target, and one click opens the invocation/output
 *  directly — never a second nested expansion. */
export const ToolGroup = memo(function ToolGroup({
  tools
}: {
  tools: ToolBlock[]
}): React.JSX.Element {
  const gkey = `g:${tools[0].callId}`
  const [override, setOverrideRaw] = useState<boolean | null>(
    openState.has(gkey) ? (openState.get(gkey) as boolean) : null
  )
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const sessions = useApp((s) => s.sessions)
  const setOverride = (v: boolean): void => {
    openState.set(gkey, v)
    setOverrideRaw(v)
  }
  const [userToggled, setUserToggled] = useState(false)
  const open = override ?? false

  const single = tools.length === 1 ? tools[0] : null
  const k = single ? kindOf(single) : null
  const app = single ? appView(single, sessions) : null
  const label = single
    ? (app?.label ??
      (k === 'mcp' || k === 'tool' ? shortName(single.name) : CHIP[k ?? 'tool'].label))
    : null
  const detail = single ? (app?.detail ?? detailOf(single, projectCwd)) : null
  const running = tools.some((t) => t.output === undefined && t.input !== undefined)
  // The hover title always tells the literal truth — for a run row that's
  // the command itself, since the label is a humanized paraphrase.
  const rawTitle =
    single && k === 'run' ? str(input(single).command) : single ? `${label} ${detail}` : null

  return (
    <div>
      <button
        onClick={() => {
          setUserToggled(true)
          setOverride(!open)
        }}
        className="group/hdr flex h-[26px] w-full items-center gap-2 px-1 text-left text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        title={rawTitle ?? groupSummary(tools, sessions)}
      >
        <ChevronTile open={open} />
        {single ? (
          <>
            <span
              className={cn(
                'shrink-0 font-medium',
                single.isError ? 'text-destructive' : 'text-foreground/80'
              )}
            >
              {label}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {running ? <TextShimmer>{detail}</TextShimmer> : detail}
            </span>
            {toolMs(single) !== undefined && (
              <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">
                {duration(toolMs(single)!)}
              </span>
            )}
            {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-busy" />}
          </>
        ) : (
          <span className="min-w-0 truncate">
            {running ? (
              <TextShimmer>{groupSummary(tools, sessions)}</TextShimmer>
            ) : (
              groupSummary(tools, sessions)
            )}
          </span>
        )}
      </button>
      <TweenHeight open={open} animate={userToggled}>
        <div className="relative">
          {/* guide rail — 1px hairline centered under the chevron tile */}
          <div className="absolute top-0 bottom-0 left-3 w-px bg-(--rail)" />
          <div className="ml-6">
            {single ? (
              <div className="mt-0.5 rounded-[9px] border border-(--chip-border) bg-(--chip-bg)">
                <ToolDetails b={single} />
              </div>
            ) : (
              tools.map((t) => <Chip key={t.id} b={t} />)
            )}
          </div>
        </div>
      </TweenHeight>
    </div>
  )
})

/** Tool names that mean "the agent touched a file". These break OUT of the
 *  folded groups: file changes carry the visual weight in a transcript. */
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch'])

interface EditModel {
  path: string
  adds: number
  dels: number
  create: boolean
  hunks: { old: string[]; new: string[] }[]
  extraPaths: string[]
  /** first changed line in the new file, when the diff names one */
  line?: number
}

/** Codex fileChange diffs: unified hunks for updates, whole content for
 *  adds. Context lines drop — the editor holds the full picture. */
function parsePatchDiff(
  diff: string,
  isAdd: boolean
): { hunks: { old: string[]; new: string[] }[]; adds: number; dels: number; line?: number } {
  const all = diff === '' ? [] : diff.split('\n')
  if (isAdd || !all.some((l) => /^[@+-]/.test(l))) {
    return { hunks: all.length ? [{ old: [], new: all }] : [], adds: all.length, dels: 0, line: 1 }
  }
  const hunks: { old: string[]; new: string[] }[] = []
  let cur: { old: string[]; new: string[] } | null = null
  let line: number | undefined
  for (const l of all) {
    if (l.startsWith('@@')) {
      const m = /\+(\d+)/.exec(l)
      if (line === undefined && m) line = Number(m[1])
      cur = { old: [], new: [] }
      hunks.push(cur)
      continue
    }
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (!cur) {
      cur = { old: [], new: [] }
      hunks.push(cur)
    }
    if (l.startsWith('+')) cur.new.push(l.slice(1))
    else if (l.startsWith('-')) cur.old.push(l.slice(1))
  }
  const kept = hunks.filter((h) => h.old.length || h.new.length)
  return {
    hunks: kept,
    adds: kept.reduce((n, h) => n + h.new.length, 0),
    dels: kept.reduce((n, h) => n + h.old.length, 0),
    line
  }
}

function editModel(b: ToolBlock): EditModel {
  const i = input(b)
  const lines = (s: string): string[] => (s === '' ? [] : s.split('\n'))
  const empty: EditModel = { path: '', adds: 0, dels: 0, create: false, hunks: [], extraPaths: [] }
  switch (b.name) {
    case 'Edit': {
      const o = lines(str(i.old_string))
      const nw = lines(str(i.new_string))
      return {
        ...empty,
        path: str(i.file_path),
        adds: nw.length,
        dels: o.length,
        hunks: [{ old: o, new: nw }]
      }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []
      const hunks = edits.map((e) => ({
        old: lines(str(e.old_string)),
        new: lines(str(e.new_string))
      }))
      return {
        ...empty,
        path: str(i.file_path),
        adds: hunks.reduce((n, h) => n + h.new.length, 0),
        dels: hunks.reduce((n, h) => n + h.old.length, 0),
        hunks
      }
    }
    case 'Write': {
      const content = lines(str(i.content))
      return {
        ...empty,
        path: str(i.file_path),
        adds: content.length,
        create: true,
        hunks: [{ old: [], new: content }]
      }
    }
    case 'NotebookEdit': {
      const src = lines(str(i.new_source))
      return {
        ...empty,
        path: str(i.notebook_path),
        adds: src.length,
        hunks: [{ old: [], new: src }]
      }
    }
    case 'apply_patch': {
      const changes = Array.isArray(b.input) ? (b.input as Record<string, unknown>[]) : []
      // splitEdit hands each card exactly one change — render its real diff.
      if (changes.length === 1) {
        const c = changes[0]
        const create = (c.kind as { type?: string } | undefined)?.type === 'add'
        const d = parsePatchDiff(str(c.diff), create)
        return {
          path: str(c.path),
          adds: d.adds,
          dels: d.dels,
          create,
          hunks: d.hunks,
          line: d.line,
          extraPaths: []
        }
      }
      const paths = changes.map((c) => str(c.path)).filter(Boolean)
      return { ...empty, path: paths[0] ?? '', extraPaths: paths.slice(1) }
    }
    default:
      return empty
  }
}

/**
 * A file change stands ALONE and loud — never folded into a group. Bordered
 * card, the file name leading, an unmissable +N / −N diffstat, expanding in
 * place to the diff. Click the diffstat side to open the working-tree diff.
 */
export const ZEditCard = memo(function ZEditCard({
  b,
  defaultOpen = false
}: {
  b: ToolBlock
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = usePersistedOpen(`e:${b.callId}`, defaultOpen)
  const [userToggled, setUserToggled] = useState(false)
  const openFileRef = useApp((s) => s.openFileRef)
  const projectId = useApp((s) => s.selectedProjectId)
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const openFileSurface = useApp((s) => s.openFileSurface)
  const m = editModel(b)
  /** The change spot, in the app's own editor — small fixes happen there. */
  const openInEditor = (): void => {
    if (!projectId) return
    let rel = m.path
    if (rel.startsWith('/') && projectCwd) {
      const root = projectCwd.endsWith('/') ? projectCwd : `${projectCwd}/`
      if (!rel.startsWith(root)) return
      rel = rel.slice(root.length)
    }
    openFileSurface(projectId, rel, m.line !== undefined ? { lineNumber: m.line, column: 1 } : null)
  }
  const running = b.output === undefined
  // Input still streaming from the driver: spinner + verb, with the file
  // name joining as soon as its value is complete and the diffstat counting
  // the changes streamed so far.
  const streamingIn = b.input === undefined || b.partialInput === true
  const [wasStreaming] = useState(streamingIn)
  // file_path streams first — a second key means its value finished.
  const pathReady = m.path !== '' && (!b.partialInput || Object.keys(input(b)).length > 1)
  // Count the diffstat up only when we watched the change land live.
  const [liveAtMount] = useState(running)
  const adds = useCountUp(m.adds, liveAtMount)
  const dels = useCountUp(m.dels, liveAtMount)
  const name = m.path.split('/').pop() ?? m.path
  const rawDir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : ''
  const shownDir = rawDir ? displayPath(rawDir, projectCwd) : ''
  const dir = shownDir === '.' ? '' : shownDir
  const verb = b.name === 'Write' ? 'Writing…' : b.name === 'apply_patch' ? 'Patching…' : 'Editing…'

  return (
    <div
      className={cn(
        'group/edit rounded-[10px] border bg-card',
        b.isError ? 'border-destructive/30' : 'border-border-strong'
      )}
    >
      <div className="flex h-9 items-center gap-2.5 pr-2 pl-2">
        <button
          onClick={() => {
            setUserToggled(true)
            setOpen(!open)
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-(--tile-strong) text-foreground/80">
            {streamingIn ? (
              <MatrixSpinner cell={2.5} />
            ) : (
              <ZIcon name={m.create ? 'document-add' : 'pen'} size={13} />
            )}
          </span>
          {streamingIn ? (
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {verb}
              {pathReady && (
                <span className="ml-1.5 font-medium text-foreground animate-[z-fade-quick_150ms_ease-out]">
                  {name}
                </span>
              )}
            </span>
          ) : (
            <span
              className={cn(
                'min-w-0 truncate text-[13px]',
                wasStreaming && 'animate-[z-fade-quick_150ms_ease-out]'
              )}
            >
              <span className="font-medium">{name || b.name}</span>
              {dir && <span className="ml-1.5 text-xs text-muted-foreground">{dir}</span>}
              {m.extraPaths.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  +{m.extraPaths.length} more
                </span>
              )}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
            {toolMs(b) !== undefined && (
              <span className="text-[10.5px] tabular-nums text-muted-foreground/50">
                {duration(toolMs(b)!)}
              </span>
            )}
            {b.isError ? (
              <span className="text-xs font-medium text-destructive">failed</span>
            ) : (
              (m.adds > 0 || m.dels > 0) && (
                <span className="text-xs font-semibold tracking-tight tabular-nums">
                  {m.adds > 0 && <span className="text-success">+{adds}</span>}
                  {m.adds > 0 && m.dels > 0 && ' '}
                  {m.dels > 0 && <span className="text-destructive">−{dels}</span>}
                </span>
              )
            )}
            {running && !streamingIn && (
              <span className="size-1.5 animate-pulse rounded-full bg-busy" />
            )}
            <ChevronTile open={open} />
          </span>
        </button>
        {m.path && (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/edit:opacity-100">
            <button
              onClick={openInEditor}
              aria-label="Edit in editor at this change"
              title="Edit in editor at this change"
              className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <ZIcon name="pen" size={12} />
            </button>
            <button
              onClick={() => openFileRef(m.path)}
              aria-label="Open diff in Changes"
              title="Open diff in Changes"
              className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <ZIcon name="expand-arrows" size={12} />
            </button>
          </span>
        )}
      </div>
      <TweenHeight open={open} animate={userToggled}>
        <div className="border-t border-(--hairline)">
          {m.hunks.length > 0 ? (
            <DiffBlock b={b} />
          ) : (
            <div className="space-y-1 px-3 py-2">
              {[m.path, ...m.extraPaths].filter(Boolean).map((p) => (
                <button
                  key={p}
                  onClick={() => openFileRef(p)}
                  className="block w-full truncate text-left font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
                >
                  {displayPath(p, projectCwd)}
                </button>
              ))}
              {b.isError && b.output !== undefined && (
                <pre className="font-mono text-[11.5px] whitespace-pre-wrap text-destructive">
                  {b.output}
                </pre>
              )}
            </div>
          )}
        </div>
      </TweenHeight>
    </div>
  )
})

/** Harness error — its own 34px chip, red family (transcript.rs error_chip). */
export function ErrorChip({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-[34px] items-center gap-2 rounded-[10px] border border-destructive/16 bg-destructive/5 px-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-destructive/12 text-destructive-muted/80">
        <ZIcon name="danger-triangle" size={12} />
      </span>
      <span className="shrink-0 text-xs font-medium text-destructive-muted/80">Error</span>
      <span className="min-w-0 truncate text-xs text-foreground/80">{text}</span>
    </div>
  )
}
