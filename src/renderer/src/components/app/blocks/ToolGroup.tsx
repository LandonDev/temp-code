import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn, displayPath } from '../../../lib/utils'
import { client } from '../../../lib/client'
import { highlight } from '../../../lib/highlight'
import { commandPhrases, humanizeCommand, pastPhrase, stripShell } from '../../../lib/humanize'
import { useApp } from '../../../state/store'

/** Monaco stays out of the startup path — loads on first in-place edit. */
const InlineEditor = lazy(() => import('../../editor/InlineEditor'))
import { ZIcon, type ZIconName } from '../zicon'
import { AddonMark } from '../AddonMark'
import { duration, ProviderMark } from '../bits'
import type { ProviderId } from '@shared/catalog'
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

/** Appshot capture files (attachments dir, `<id>-appshot.jpg` / `.md`). */
const isAppshotPath = (p: string): boolean => /-appshot\.(png|jpg|md)$/.test(p)

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

/** Thread titles/providers for resolving ids in tool rows; ids never render. */
type ThreadTitles = Record<string, { title: string; provider?: ProviderId } | undefined>

/** Orchestrator subagent ops; claude's own Agent/Task tool rides along. */
const AGENT_TOOLS = new Set([
  'spawn_agent',
  'send_to_agent',
  'check_agent',
  'wait_for_agent',
  'interrupt_agent',
  'answer_agent'
])

/** The subagent session this call is about — input arg, or the spawn result. */
function agentIdOf(b: ToolBlock): string | null {
  const fromInput = str(input(b).agentId)
  if (fromInput) return fromInput
  const m = b.output ? /"agentId"\s*:\s*"([\w-]+)"/.exec(b.output) : null
  return m?.[1] ?? null
}

/** Which provider's model runs the subagent behind this call — drives the
 *  brand mark on the row. */
function agentProviderOf(b: ToolBlock, titles: ThreadTitles): ProviderId | null {
  const n = shortName(b.name)
  if (n === 'Agent' || n === 'Task') return 'claude'
  if (!AGENT_TOOLS.has(n)) return null
  const id = agentIdOf(b)
  const known = id ? titles[id]?.provider : undefined
  if (known) return known
  const p = str(input(b).provider).toLowerCase()
  if (/codex|gpt|openai/.test(p)) return 'codex'
  if (/cursor|composer/.test(p)) return 'cursor'
  return p ? 'claude' : null
}

/** In-house app_* tools render as what they DO. The raw input stays one
 *  click away in the expansion, like every other tool. */
function appView(
  b: ToolBlock,
  titles: ThreadTitles
): { label: string; detail: string; phrase: string } | null {
  const i = input(b)
  // Reads of a capture's files say what they are — the nanoid filename
  // means nothing to anyone.
  if (isAppshotPath(pathOf(b))) {
    return { label: 'Read', detail: 'appshot', phrase: 'read the appshot' }
  }
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
  const name = shortName(b.name)
  // Subagent calls read as who was asked to do what, never as raw ids.
  if (AGENT_TOOLS.has(name) || name === 'Agent' || name === 'Task') {
    const id = agentIdOf(b)
    const title = id ? titles[id]?.title : undefined
    const verb =
      name === 'spawn_agent'
        ? 'Spawned'
        : name === 'send_to_agent'
          ? 'Messaged'
          : name === 'wait_for_agent'
            ? 'Waited for'
            : name === 'interrupt_agent'
              ? 'Stopped'
              : name === 'check_agent'
                ? 'Checked'
                : name === 'answer_agent'
                  ? 'Answered'
                  : 'Subagent'
    const task = trim(str(i.description) || str(i.task) || str(i.prompt) || str(i.message), 48)
    return {
      label: verb,
      detail: title ?? task,
      phrase: `${verb === 'Subagent' ? 'ran' : verb.toLowerCase()} ${title ? `“${trim(title, 24)}”` : 'a subagent'}`
    }
  }
  if (name === 'list_agents') {
    return { label: 'Agents', detail: 'listed', phrase: 'listed the subagents' }
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
  // Addon calls speak the Codex app's language: "Save document in Linear".
  if (t.display?.action) {
    return [t.display.app ? `${t.display.action} in ${t.display.app}` : t.display.action]
  }
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

interface SectionSummary {
  sentence: string | null
  captions: (string | null)[]
}

/** Model-written summaries, keyed per settled group (+ whether captions
 *  were requested). `null` marks in-flight or failed — the mechanical
 *  text stays as the fallback. Server-side results cache permanently, so
 *  this is one request per group per app run at most. */
const summaryCache = new Map<string, SectionSummary | null>()

/** One plain sentence (and, when enabled, per-tool captions) for a
 *  FINALIZED tool section, written by a small fast model — the thread's own
 *  subscription on Auto, or the pinned model from settings. `active` means
 *  the section may still grow (nothing follows it yet, turn running):
 *  summarizing then would fire again on every new tool and override
 *  itself, so it waits. */
function useSectionSummary(
  tools: ToolBlock[],
  sessionId?: string,
  active = false
): SectionSummary | null {
  const wantSentence = useApp((s) => s.toolSummaries)
  const wantCaptions = useApp((s) => s.toolCaptions)
  const model = useApp((s) => s.summaryModel)
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const settled = !active && tools.length > 0 && tools.every((t) => t.output !== undefined)
  const want = settled && (wantCaptions || (wantSentence && tools.length > 1))
  const key = want ? `${tools[0].callId}:${tools.length}:${wantCaptions ? 'c' : 's'}` : null
  const [, bump] = useState(0)
  useEffect(() => {
    if (!key || !sessionId || summaryCache.has(key)) return
    let alive = true
    summaryCache.set(key, null)
    const items = tools.slice(0, 24).map((t) => ({
      name: shortName(t.name),
      detail: detailOf(t, projectCwd),
      output: t.output ? t.output.slice(0, 220) : undefined
    }))
    void client
      .request<SectionSummary | null>('tools.summarize', {
        sessionId,
        groupKey: `${tools[0].callId}:${tools.length}`,
        items,
        model,
        captions: wantCaptions
      })
      .then((r) => {
        if (r) {
          summaryCache.set(key, r)
          if (alive) bump((n) => n + 1)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per settled group
  }, [key, sessionId])
  return key ? (summaryCache.get(key) ?? null) : null
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
export function TweenHeight({
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
    // Start from wherever the element actually is — a toggle that lands
    // mid-tween continues from the current height instead of jumping.
    const from = el.offsetHeight
    const done = (): void => {
      el.style.transition = 'none'
      el.style.height = open ? 'auto' : '0px'
      el.removeEventListener('transitionend', done)
    }
    // Same height both ways → transitionend never fires; snap to final.
    if (from === target) {
      done()
      return
    }
    el.style.transition = 'none'
    el.style.height = `${from}px`
    // Force the start frame, then tween to the target (RESIZE: 200ms ease-out).
    void el.offsetHeight
    el.style.transition = 'height 200ms ease-out'
    el.style.height = `${target}px`
    el.addEventListener('transitionend', done)
    // Hidden tabs and interrupted transitions can swallow transitionend —
    // without this, height sticks at a fixed px and later toggles look dead.
    const fallback = window.setTimeout(done, 260)
    return () => {
      el.removeEventListener('transitionend', done)
      clearTimeout(fallback)
    }
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

/** One line of a unified diff view. `gap` separates hunks. */
interface DiffRow {
  type: 'add' | 'del' | 'ctx' | 'gap'
  oldNo?: number
  newNo?: number
  text: string
}

/** Hunks → unnumbered rows — the fallback while line numbers resolve. */
function rowsFromHunks(hunks: { old: string[]; new: string[] }[]): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((h, n) => {
    if (n > 0) rows.push({ type: 'gap', text: '' })
    for (const t of h.old) rows.push({ type: 'del', text: t })
    for (const t of h.new) rows.push({ type: 'add', text: t })
  })
  return rows
}

/** First index where `seq` appears contiguously in `lines`, else -1. */
function findSeq(lines: string[], seq: string[]): number {
  if (!seq.length) return -1
  outer: for (let i = 0; i <= lines.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (lines[i + j] !== seq[j]) continue outer
    }
    return i
  }
  return -1
}

/** Where a hunk's landed text starts in the file. Exact match first; if
 *  the user has since tweaked the middle, anchor on an edge line. */
function locateStart(lines: string[], h: { old: string[]; new: string[] }): number {
  const exact = findSeq(lines, h.new)
  if (exact !== -1 || h.new.length === 0) return exact
  const first = lines.indexOf(h.new[0])
  if (first !== -1) return first
  const last = lines.lastIndexOf(h.new[h.new.length - 1])
  return last === -1 ? -1 : Math.max(0, last - (h.new.length - 1))
}

/** Number hunks by finding the landed text in the file, wrapped in two
 *  lines of context. Added rows render the file's CURRENT lines, so an
 *  in-place tweak shows up when the diff re-locates after a save. */
function locateHunks(hunks: { old: string[]; new: string[] }[], content: string): DiffRow[] {
  const lines = content.split('\n')
  const rows: DiffRow[] = []
  hunks.forEach((h, n) => {
    if (n > 0) rows.push({ type: 'gap', text: '' })
    const start = locateStart(lines, h)
    if (start === -1) {
      for (const t of h.old) rows.push({ type: 'del', text: t })
      for (const t of h.new) rows.push({ type: 'add', text: t })
      return
    }
    for (let i = Math.max(0, start - 2); i < start; i++) {
      rows.push({ type: 'ctx', newNo: i + 1, text: lines[i] })
    }
    for (const t of h.old) rows.push({ type: 'del', text: t })
    h.new.forEach((_, j) => {
      rows.push({ type: 'add', newNo: start + j + 1, text: lines[start + j] ?? '' })
    })
    const end = start + h.new.length
    for (let i = end; i < Math.min(lines.length, end + 2); i++) {
      rows.push({ type: 'ctx', newNo: i + 1, text: lines[i] })
    }
  })
  return rows
}

/** Rows for a card's diff: codex patches carry numbers and context in the
 *  diff itself; claude edits locate theirs by reading the landed file.
 *  `refresh` re-locates (any provider) after an in-place edit saved, so
 *  the diff shows the file as it now is, not as the patch left it. */
function useDiffRows(b: ToolBlock, m: EditModel, refresh = 0): DiffRow[] {
  const projectId = useApp((s) => s.selectedProjectId)
  const cwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const [located, setLocated] = useState<DiffRow[] | null>(null)
  const needsLocate = m.hunks.length > 0 && b.output !== undefined && (!m.rows || refresh > 0)
  useEffect(() => {
    if (!needsLocate || !projectId) return
    let alive = true
    let rel = m.path
    let req: Promise<string | null>
    const root = cwd ? (cwd.endsWith('/') ? cwd : `${cwd}/`) : null
    if (rel.startsWith('/') && (!root || !rel.startsWith(root))) {
      // Outside the selected project (another project, a worktree): the
      // absolute read still resolves — line numbers survive the mismatch.
      req = client.request<string | null>('file.read', { path: rel })
    } else {
      if (root && rel.startsWith(root)) rel = rel.slice(root.length)
      req = client.request<string | null>('fs.read', { projectId, path: rel })
    }
    void req
      .then((content) => {
        if (alive && content !== null) setLocated(locateHunks(m.hunks, content))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per block, not per render
  }, [b.id, needsLocate, projectId, refresh])
  if (refresh > 0 && located) return located
  return m.rows ?? located ?? rowsFromHunks(m.hunks)
}

/** Contiguous numbered add-runs — what the model changed, for the inline
 *  editor's line wash. */
function addRanges(rows: DiffRow[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const r of rows) {
    if (r.type !== 'add' || r.newNo === undefined) continue
    const last = out.at(-1)
    if (last && r.newNo === last.end + 1) last.end = r.newNo
    else out.push({ start: r.newNo, end: r.newNo })
  }
  return out
}

/** File extension → shiki language id; unknowns render plain (never
 *  mis-colored). */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  java: 'java',
  kt: 'kotlin',
  py: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  md: 'markdown',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
  rb: 'ruby',
  php: 'php',
  swift: 'swift'
}
export const langOf = (path: string): string | null =>
  LANG_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? null

/** Settled-pass syntax highlighting (M24): one worker run per card, split
 *  back into per-row innerHTML. Streaming rows stay plain (rule: fast). */
function useDiffHighlight(rows: DiffRow[], path?: string, settled?: boolean): (string | null)[] {
  const [html, setHtml] = useState<(string | null)[]>([])
  const lang = path ? langOf(path) : null
  // Only the shown slice goes to the worker — a diff past the cap still
  // gets its visible lines colored instead of losing highlighting entirely.
  const joined = useMemo(
    () =>
      rows
        .slice(0, DIFF_LINE_CAP)
        .map((r) => (r.type === 'gap' ? '' : r.text))
        .join('\n'),
    [rows]
  )
  useEffect(() => {
    if (!settled || !lang || rows.length === 0) {
      setHtml([])
      return
    }
    let alive = true
    void highlight(joined, lang).then((h) => {
      if (!alive || !h) return
      // Line spans hold NESTED token spans — a non-greedy regex to the
      // first </span> truncates every multi-token line. Newlines only
      // exist BETWEEN line spans, so split on them and peel the wrapper.
      const body = /<code[^>]*>([\s\S]*)<\/code>/.exec(h)?.[1] ?? ''
      const lines = body
        .split('\n')
        .map((l) => l.replace(/^<span class="line">/, '').replace(/<\/span>$/, ''))
      if (lines.length > 0) setHtml(lines)
    })
    return () => {
      alive = false
    }
  }, [joined, lang, settled, rows.length])
  return html
}

/** Past this many rows, a dense diff caps its height and scrolls inside. */
const DENSE_VIEWPORT_ROWS = 28

/** Unified diff — line numbers in the gutter, dim context, emerald adds,
 *  red deletes, capped at 600 lines. Click a numbered line to edit there.
 *  `dense` (the implementation board): tighter type, lines render whole on
 *  one row each (horizontal scroll instead of wrapping), and a large diff
 *  caps at ~half the viewport and scrolls inside — pinned to the bottom
 *  while it streams or reveals, free once settled. Exported for the
 *  board's shell-edit cards (M23 disk truth). */
export function DiffBlock({
  rows,
  path,
  settled,
  visible,
  dense,
  onEditAt
}: {
  rows: DiffRow[]
  /** enables syntax highlighting once settled */
  path?: string
  settled?: boolean
  /** reveal pass (M23): only the first N rows render — the diff streams in */
  visible?: number
  dense?: boolean
  onEditAt?: (line: number) => void
}): React.JSX.Element {
  const shown = rows.slice(0, Math.min(DIFF_LINE_CAP, visible ?? Infinity))
  const html = useDiffHighlight(rows, path, settled)
  const capped = dense && rows.length > DENSE_VIEWPORT_ROWS
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !capped) return
    // Streaming/revealing: the newest rows are the story — follow them.
    if (!settled || visible !== undefined) el.scrollTop = el.scrollHeight
  }, [capped, settled, visible, rows.length])
  return (
    <div
      ref={scroller}
      className={cn(
        'font-mono',
        dense ? 'py-1 text-[11px] leading-[16px]' : 'py-1.5 text-[11.5px] leading-[18px]',
        capped && 'max-h-[min(48vh,540px)] overflow-auto overscroll-contain'
      )}
    >
      <div className={cn(dense && 'min-w-max')}>
        {shown.map((r, n) =>
          r.type === 'gap' ? (
            <div key={n} className="px-3 py-0.5 text-[10px] text-faint select-none">
              ⋯
            </div>
          ) : (
            <div
              key={n}
              onClick={onEditAt && r.newNo !== undefined ? () => onEditAt(r.newNo!) : undefined}
              title={onEditAt && r.newNo !== undefined ? 'Edit here' : undefined}
              className={cn(
                'flex',
                r.type === 'add' && 'bg-success/10',
                r.type === 'del' && 'bg-destructive/10',
                r.type === 'add' && !html[n] && 'text-success',
                r.type === 'del' && !html[n] && 'text-destructive',
                r.type === 'ctx' && 'text-muted-foreground/70',
                onEditAt && r.newNo !== undefined && 'cursor-pointer hover:brightness-125'
              )}
            >
              <span
                className={cn(
                  'shrink-0 pr-2 text-right text-[10px] text-faint tabular-nums select-none',
                  dense ? 'w-9 leading-[16px]' : 'w-10 leading-[18px]'
                )}
              >
                {r.type === 'del' ? (r.oldNo ?? '') : (r.newNo ?? '')}
              </span>
              <span
                className={cn(
                  'shrink-0 select-none',
                  dense ? 'w-3.5' : 'w-4',
                  r.type === 'add' && 'text-success',
                  r.type === 'del' && 'text-destructive'
                )}
              >
                {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}
              </span>
              {html[n] ? (
                // `shiki` puts the row under main.css's dual-theme flip —
                // without it dark mode renders the LIGHT palette's near-black
                // tokens on the dark background.
                <span
                  className={cn(
                    'shiki',
                    dense
                      ? 'pr-4 whitespace-pre'
                      : 'min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]'
                  )}
                  dangerouslySetInnerHTML={{ __html: html[n]! }}
                />
              ) : (
                <span
                  className={cn(
                    dense
                      ? 'pr-4 whitespace-pre'
                      : 'min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]'
                  )}
                >
                  {r.text || ' '}
                </span>
              )}
            </div>
          )
        )}
        {rows.length > DIFF_LINE_CAP && visible === undefined && (
          <div className="px-3 text-[10.5px] text-faint">… diff truncated</div>
        )}
      </div>
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
const Chip = memo(function Chip({
  b,
  caption
}: {
  b: ToolBlock
  /** model-written note of what this call did; replaces the derived detail */
  caption?: string | null
}): React.JSX.Element {
  const [open, setOpen] = usePersistedOpen(b.callId)
  const [userToggled, setUserToggled] = useState(false)
  const projectCwd = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId)?.cwd)
  const sessions = useApp((s) => s.sessions)
  const k = kindOf(b)
  const chip = CHIP[k]
  const app = appView(b, sessions)
  const agentProv = agentProviderOf(b, sessions)
  const detail = caption ?? app?.detail ?? detailOf(b, projectCwd)
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
            {loading ? (
              <MatrixSpinner cell={2} />
            ) : b.display?.app ? (
              <AddonMark command={{ name: b.display.app, source: 'plugin' }} size={12} />
            ) : agentProv ? (
              <ProviderMark provider={agentProv} size={12} />
            ) : (
              <ZIcon name={chip.icon} size={12} />
            )}
          </span>
          <span
            className={cn(
              'shrink-0 font-medium',
              b.isError ? 'text-destructive' : loading ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {b.display?.action ??
              app?.label ??
              (k === 'mcp' || k === 'tool' ? shortName(b.name) : chip.label)}
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
          {b.reauth && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                window.open(b.reauth!.url)
              }}
              onKeyDown={(e) => e.key === 'Enter' && window.open(b.reauth!.url)}
              title={`Reconnect ${b.reauth.app} — opens ChatGPT's app page`}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warning transition hover:bg-warning/20 active:scale-95"
            >
              Reconnect {b.reauth.app}
            </span>
          )}
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

/** The folded group row. The ACTIVE group — the one tools are streaming
 *  into, nothing after it yet — rides open (`autoOpen`), each new chip
 *  landing in view; when the next text block arrives it stops being last
 *  and folds shut (a 200ms tween, not a snap). The user's toggle
 *  overrides either way. Chips themselves stay collapsed — no dumps.
 *
 *  A single tool skips the generic summary ("Called 1 tool") entirely: the
 *  header IS the verb + target, and one click opens the invocation/output
 *  directly — never a second nested expansion. */
export const ToolGroup = memo(function ToolGroup({
  tools,
  autoOpen = false,
  active = false,
  sessionId
}: {
  tools: ToolBlock[]
  autoOpen?: boolean
  /** the section may still grow — summaries wait until it's finalized */
  active?: boolean
  sessionId?: string
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
  // Auto-open shows the CHIP LIST growing — a single tool has no list,
  // its expansion is the invocation/output dump, so it stays folded.
  const open = override ?? (autoOpen && tools.length > 1)
  const summary = useSectionSummary(tools, sessionId, active)
  const wantSentence = useApp((s) => s.toolSummaries)
  const sentence = wantSentence ? (summary?.sentence ?? null) : null

  const single = tools.length === 1 ? tools[0] : null
  const k = single ? kindOf(single) : null
  const app = single ? appView(single, sessions) : null
  const label = single
    ? (single.display?.action ??
      app?.label ??
      (k === 'mcp' || k === 'tool' ? shortName(single.name) : CHIP[k ?? 'tool'].label))
    : null
  const mechanicalDetail = single ? (app?.detail ?? detailOf(single, projectCwd)) : null
  const detail = single ? (summary?.captions[0] ?? mechanicalDetail) : null
  const singleAgentProv = single ? agentProviderOf(single, sessions) : null
  const running = tools.some((t) => t.output === undefined && t.input !== undefined)
  // The hover title always tells the literal truth — for a run row that's
  // the command itself, since the label is a humanized paraphrase.
  const rawTitle =
    single && k === 'run'
      ? str(input(single).command)
      : single
        ? `${label} ${mechanicalDetail}`
        : null

  return (
    <div>
      <button
        onClick={() => setOverride(!open)}
        className="group/hdr flex h-[26px] w-full items-center gap-2 px-1 text-left text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        title={rawTitle ?? groupSummary(tools, sessions)}
      >
        <ChevronTile open={open} />
        {single ? (
          <>
            {single.display?.app ? (
              <AddonMark
                command={{ name: single.display.app, source: 'plugin' }}
                size={12}
                className="shrink-0"
              />
            ) : singleAgentProv ? (
              <ProviderMark provider={singleAgentProv} size={12} className="shrink-0" />
            ) : null}
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
          <span className="min-w-0 flex-1 truncate">
            {running ? (
              <TextShimmer>{groupSummary(tools, sessions)}</TextShimmer>
            ) : (
              (sentence ?? groupSummary(tools, sessions))
            )}
          </span>
        )}
        {/* a connector inside wants reauth — the fix must not hide behind
            the fold, so the collapsed header wears it too */}
        {(() => {
          const reauth = tools.find((t) => t.reauth)?.reauth
          if (!reauth) return null
          return (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                window.open(reauth.url)
              }}
              onKeyDown={(e) => e.key === 'Enter' && window.open(reauth.url)}
              title={`Reconnect ${reauth.app} — opens ChatGPT's app page`}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warning transition hover:bg-warning/20 active:scale-95"
            >
              Reconnect {reauth.app}
            </span>
          )
        })()}
      </button>
      {/* animate: true — auto-collapse (text arrived) tweens like a user
          toggle; first mount still renders at final size instantly. */}
      <TweenHeight open={open} animate>
        <div className="relative">
          {/* guide rail — 1px hairline centered under the chevron tile */}
          <div className="absolute top-0 bottom-0 left-3 w-px bg-(--rail)" />
          <div className="ml-6">
            {single ? (
              <div className="mt-0.5 rounded-[9px] border border-(--chip-border) bg-(--chip-bg)">
                <ToolDetails b={single} />
              </div>
            ) : (
              tools.map((t, n) => <Chip key={t.id} b={t} caption={summary?.captions[n] ?? null} />)
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
  /** numbered unified rows, when the source diff carries them (codex) */
  rows?: DiffRow[]
}

/** Codex fileChange diffs: unified hunks for updates (context and line
 *  numbers kept as rows), whole numbered content for adds. Exported for
 *  the live change stream's disk diffs (docs/PLAN-5.md M22/M23). */
export function parsePatchDiff(
  diff: string,
  isAdd: boolean
): {
  hunks: { old: string[]; new: string[] }[]
  adds: number
  dels: number
  line?: number
  rows: DiffRow[]
} {
  const all = diff === '' ? [] : diff.split('\n')
  if (isAdd || !all.some((l) => /^[@+-]/.test(l))) {
    return {
      hunks: all.length ? [{ old: [], new: all }] : [],
      adds: all.length,
      dels: 0,
      line: 1,
      rows: all.map((text, n) => ({ type: 'add', newNo: n + 1, text }))
    }
  }
  const hunks: { old: string[]; new: string[] }[] = []
  const rows: DiffRow[] = []
  let cur: { old: string[]; new: string[] } | null = null
  let line: number | undefined
  let oldNo = 0
  let newNo = 0
  for (const l of all) {
    if (l.startsWith('@@')) {
      const m = /-(\d+)[^+]*\+(\d+)/.exec(l)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
        if (line === undefined) line = newNo
      }
      if (cur) rows.push({ type: 'gap', text: '' })
      cur = { old: [], new: [] }
      hunks.push(cur)
      continue
    }
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (!cur) {
      cur = { old: [], new: [] }
      hunks.push(cur)
    }
    if (l.startsWith('+')) {
      cur.new.push(l.slice(1))
      rows.push({ type: 'add', newNo: newNo++, text: l.slice(1) })
    } else if (l.startsWith('-')) {
      cur.old.push(l.slice(1))
      rows.push({ type: 'del', oldNo: oldNo++, text: l.slice(1) })
    } else {
      rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: l.replace(/^ /, '') })
    }
  }
  const kept = hunks.filter((h) => h.old.length || h.new.length)
  return {
    hunks: kept,
    adds: kept.reduce((n, h) => n + h.new.length, 0),
    dels: kept.reduce((n, h) => n + h.old.length, 0),
    line,
    rows
  }
}

export function editModel(b: ToolBlock): EditModel {
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
        line: 1,
        hunks: [{ old: [], new: content }],
        rows: content.map((text, n) => ({ type: 'add', newNo: n + 1, text }))
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
    // Synthetic block fusing every edit a task made to one file (the
    // board's "whole change" card) — hunks run in call order.
    case '__merged__': {
      const hunks = (Array.isArray(i.hunks) ? i.hunks : []) as { old: string[]; new: string[] }[]
      return {
        ...empty,
        path: str(i.file_path),
        create: i.create === true,
        adds: hunks.reduce((n, h) => n + h.new.length, 0),
        dels: hunks.reduce((n, h) => n + h.old.length, 0),
        hunks
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
          rows: d.rows,
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
  defaultOpen = false,
  pinnedOpen = false,
  dense = false,
  sessionId
}: {
  b: ToolBlock
  defaultOpen?: boolean
  /** diff stays open regardless of persisted/auto state (the board's
   *  morphed-open card — closing it is the surrounding morph, not a fold) */
  pinnedOpen?: boolean
  /** board mode: tighter diff type, unwrapped lines, big diffs cap+scroll */
  dense?: boolean
  /** enables the live disk-diff overlay + auto open/collapse (M23) */
  sessionId?: string
}): React.JSX.Element {
  const [open, setOpen] = usePersistedOpen(`e:${b.callId}`, defaultOpen)
  const [userToggled, setUserToggled] = useState(false)
  const openFileRef = useApp((s) => s.openFileRef)
  const project = useApp((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const projectCwd = project?.cwd
  const openFileSurface = useApp((s) => s.openFileSurface)
  const m = editModel(b)
  // In-place editing: the dropdown swaps its diff for the real editor.
  const [editMode, setEditMode] = useState(false)
  const [editLine, setEditLine] = useState<number | undefined>()
  // Bumped when an in-place edit saves, so the diff re-locates its lines.
  const [refresh, setRefresh] = useState(0)
  const rows = useDiffRows(b, m, refresh)
  /** Project-relative path, or null when the file is outside the project. */
  const rel = ((): string | null => {
    if (!m.path.startsWith('/')) return m.path || null
    if (!projectCwd) return null
    const root = projectCwd.endsWith('/') ? projectCwd : `${projectCwd}/`
    return m.path.startsWith(root) ? m.path.slice(root.length) : null
  })()
  /** The change spot, in the full editor surface. */
  const openInEditor = (): void => {
    if (!project || !rel) return
    openFileSurface(
      project.id,
      rel,
      m.line !== undefined ? { lineNumber: m.line, column: 1 } : null
    )
  }
  const editHere = (line?: number): void => {
    setEditLine(line ?? m.line)
    setEditMode(true)
    setUserToggled(true)
    setOpen(true)
  }
  const running = b.output === undefined
  // Input still streaming from the driver: spinner + verb, with the file
  // name joining as soon as its value is complete and the diffstat counting
  // the changes streamed so far.
  const streamingIn = b.input === undefined || b.partialInput === true
  const [wasStreaming] = useState(streamingIn)
  // file_path streams first — a second key means its value finished.
  const pathReady = m.path !== '' && (!b.partialInput || Object.keys(input(b)).length > 1)

  // Live disk-diff overlay (M22/M23): while the call is in flight, the
  // watcher's disk truth beats the harness's buffered input — rows grow
  // and the counters tick as the file actually changes. Once the harness
  // result lands, the harness diff is authoritative again.
  const liveRec = useApp((s) => {
    if (!sessionId || !running) return undefined
    const rel = m.path.startsWith('/') ? undefined : m.path
    const byRel = rel ? s.liveEdits[sessionId]?.[rel] : undefined
    if (byRel) return byRel
    // Absolute harness paths match by suffix against the cwd-relative key.
    const all = s.liveEdits[sessionId]
    if (!all || !m.path) return undefined
    return Object.values(all).find((e) => m.path.endsWith(`/${e.path}`))
  })
  const liveParsed = useMemo(
    () => (liveRec?.diff ? parsePatchDiff(liveRec.diff, liveRec.kind === 'created') : null),
    [liveRec]
  )

  // Count the diffstat up only when we watched the change land live.
  const [liveAtMount] = useState(running)

  // The edit itself lands in one atomic write (the CLI buffers input
  // deltas; the disk write is single) — so the "streaming" the user sees
  // is a REVEAL: when a watched call settles, its diff rows pour in fast,
  // hold a beat with the card open, then the card folds to its chip.
  const rowsRef = useRef<number>(0)
  const [revealed, setRevealed] = useState<number | null>(null)
  const [holdOpen, setHoldOpen] = useState(running)
  useEffect(() => {
    rowsRef.current = rows.length
  }, [rows.length])
  useEffect(() => {
    if (running || !liveAtMount || !sessionId) return
    let raf = 0
    let t: number | undefined
    const t0 = performance.now()
    const dur = Math.min(900, 150 + rowsRef.current * 6)
    const tick = (nowT: number): void => {
      const p = Math.min(1, Math.max(0, (nowT - t0) / dur))
      setRevealed(Math.max(1, Math.round(p * rowsRef.current)))
      if (p < 1) raf = requestAnimationFrame(tick)
      else {
        setRevealed(null)
        t = window.setTimeout(() => setHoldOpen(false), 800)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      if (t !== undefined) clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one reveal per settle
  }, [running])
  const adds = useCountUp(liveRec && running ? (liveRec.adds ?? 0) : m.adds, liveAtMount)
  const dels = useCountUp(liveRec && running ? (liveRec.dels ?? 0) : m.dels, liveAtMount)
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
              (adds > 0 || dels > 0) && (
                <span className="text-xs font-semibold tracking-tight tabular-nums">
                  {adds > 0 && <span className="text-success">+{adds}</span>}
                  {adds > 0 && dels > 0 && ' '}
                  {dels > 0 && <span className="text-destructive">−{dels}</span>}
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
          <span className="flex w-0 shrink-0 items-center overflow-hidden opacity-0 transition-all duration-200 group-hover/edit:w-12 group-hover/edit:opacity-100">
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
      {/* Auto mode (sessionId given): the diff is open while the edit is
          happening AND through the reveal+hold after it lands, then
          collapses to the chip — unless the user toggled, which always
          wins. pinnedOpen (the board's morphed card) trumps everything. */}
      <TweenHeight
        open={pinnedOpen ? true : userToggled ? open : sessionId ? running || holdOpen : open}
        animate
      >
        <div className="relative border-t border-(--hairline)">
          {editMode && project && rel ? (
            <>
              <button
                onClick={() => setEditMode(false)}
                className="absolute top-1.5 right-2 z-10 text-[10px] font-medium text-faint transition-colors duration-150 hover:text-foreground"
              >
                diff
              </button>
              <Suspense
                fallback={
                  <div className="flex h-80 items-center justify-center">
                    <MatrixSpinner />
                  </div>
                }
              >
                <InlineEditor
                  project={project}
                  path={rel}
                  line={editLine ?? m.line}
                  highlight={addRanges(rows)}
                  onSave={() => {
                    setEditMode(false)
                    setRefresh((n) => n + 1)
                  }}
                />
              </Suspense>
            </>
          ) : running && liveParsed ? (
            // In flight: the disk truth streams — rows grow with each write.
            <DiffBlock rows={liveParsed.rows} dense={dense} />
          ) : m.hunks.length > 0 ? (
            <>
              {project && rel && (
                <button
                  onClick={() => editHere()}
                  title="Edit in place"
                  className="absolute top-1.5 right-2 z-10 text-[10px] font-medium text-faint transition-colors duration-150 hover:text-foreground"
                >
                  edit
                </button>
              )}
              <DiffBlock
                rows={rows}
                path={m.path}
                settled={!running}
                visible={revealed ?? undefined}
                dense={dense}
                onEditAt={project && rel ? (line) => editHere(line) : undefined}
              />
            </>
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

/** Harness error — its own 34px chip, red family (transcript.rs error_chip).
 *  With a sessionId, an errored session grows a Continue button: the user
 *  fixed what killed the turn (switched accounts on a session limit), one
 *  click settles every chip and the harness picks the work back up. */
export function ErrorChip({
  text,
  sessionId
}: {
  text: string
  sessionId?: string
}): React.JSX.Element {
  const errored = useApp((s) => (sessionId ? s.sessions[sessionId]?.status === 'error' : false))
  const [busy, setBusy] = useState(false)
  const onContinue = (): void => {
    if (busy || !sessionId) return
    setBusy(true)
    client.request('session.continue', { sessionId }).finally(() => setBusy(false))
  }
  return (
    <div className="flex h-[34px] items-center gap-2 rounded-[10px] border border-destructive/16 bg-destructive/5 px-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-destructive/12 text-destructive-muted/80">
        <ZIcon name="danger-triangle" size={12} />
      </span>
      <span className="shrink-0 text-xs font-medium text-destructive-muted/80">Error</span>
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">{text}</span>
      {errored && (
        <button
          onClick={onContinue}
          disabled={busy}
          className="shrink-0 rounded-[6px] bg-destructive/12 px-2 py-1 text-[11px] font-medium text-destructive-muted transition-colors hover:bg-destructive/20 disabled:opacity-60"
        >
          {busy ? 'Continuing…' : 'Continue'}
        </button>
      )}
    </div>
  )
}
