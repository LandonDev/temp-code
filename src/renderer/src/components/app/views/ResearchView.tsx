import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, MessageSquare, Search } from 'lucide-react'
import type { SessionMeta } from '@shared/events'
import { useApp } from '../../../state/store'
import type { Block } from '../../../state/blocks'
import { cn } from '../../../lib/utils'
import { EASE_OUT } from '../../../lib/ease'
import { StatusDot } from '../bits'
import { MarkdownText } from '../blocks/MarkdownText'
import { Spinner } from '../../ui/spinner'
import { Transcript } from '../Transcript'
import { WorkingStrip } from '../WorkingStrip'
import { PromptBar } from '../PromptBar'
import { AgentDetail, FleetPulseLine, useAgents } from '../AgentFleet'

/**
 * Research thread: the SOURCES are the view. It opens as a normal chat;
 * the moment research activity lands (a source boarded, the report file
 * born) a live board slides in on the left — report pin on top, then one
 * group per research angle with its queries and the sources they surfaced
 * streaming in beneath. The chat docks right like Implementation's, stays
 * mounted when folded, and folds itself once the report is complete.
 */

// ── the board's data: research-source events folded into angle groups ──

interface SourceRow {
  url: string
  title?: string
}
interface QueryGroup {
  /** null = sources fetched before any query (direct fetches) */
  query: string | null
  sources: SourceRow[]
}
interface Angle {
  agentId: string
  label: string
  queries: QueryGroup[]
}

/** Fold the session's research-source events (appended to the root by the
 *  server-side harvest) into angle groups. An event re-delivered with the
 *  same callId only enriches the earlier row (title arriving late). The
 *  totals count unique URLs and queries across the whole thread — a source
 *  two angles consulted shows in both groups but counts once. */
function useResearchBoard(sessionId: string): {
  angles: Angle[]
  sources: number
  searches: number
} {
  const rows = useApp((s) => s.events[sessionId])
  return useMemo(() => {
    const angles: Angle[] = []
    const byAgent = new Map<string, Angle>()
    const byCall = new Map<string, SourceRow>()
    const urls = new Set<string>()
    const queries = new Set<string>()
    for (const row of rows ?? []) {
      const e = row.event
      if (e.type !== 'research-source') continue
      const known = byCall.get(e.callId)
      if (known) {
        if (e.title) known.title = e.title
        continue
      }
      let angle = byAgent.get(e.agentId)
      if (!angle) {
        angle = { agentId: e.agentId, label: e.agentLabel, queries: [] }
        byAgent.set(e.agentId, angle)
        angles.push(angle)
      }
      if (e.query) {
        queries.add(e.query)
        angle.queries.push({ query: e.query, sources: [] })
      } else if (e.url) {
        urls.add(e.url)
        let group = angle.queries.at(-1)
        if (!group) {
          group = { query: null, sources: [] }
          angle.queries.push(group)
        }
        const src: SourceRow = { url: e.url, title: e.title }
        group.sources.push(src)
        byCall.set(e.callId, src)
      }
    }
    return { angles, sources: urls.size, searches: queries.size }
  }, [rows])
}

// ── the report file: frontmatter + body, polled like the plan ──────────

interface Report {
  title: string | null
  status: string | null
  summary: string | null
  body: string
}

function parseReport(md: string): Report {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
  const fm = m?.[1] ?? ''
  const get = (k: string): string | null =>
    fm
      .match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? null
  return {
    title: get('title') ?? md.match(/^#\s+(.+)$/m)?.[1] ?? null,
    status: get('status'),
    summary: get('summary'),
    body: m ? md.slice(m[0].length) : md
  }
}

// ── favicon with a letter-tile fallback (no main-process caching) ──────

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function Favicon({ url }: { url: string }): React.JSX.Element {
  const host = hostOf(url)
  const [failed, setFailed] = useState(false)
  if (!host || failed) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-secondary text-[9px] font-semibold text-muted-foreground uppercase">
        {host[0] ?? '?'}
      </span>
    )
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`}
      onError={() => setFailed(true)}
      alt=""
      className="size-4 shrink-0 rounded-[4px]"
    />
  )
}

// ── the view ───────────────────────────────────────────────────────────

export function ResearchView({ session }: { session: SessionMeta }): React.JSX.Element {
  const readFile = useApp((s) => s.readFile)
  const stopped = useApp((s) => s.stopped[session.id])
  const sessions = useApp((s) => s.sessions)
  const board = useResearchBoard(session.id)
  // Children loaded for the angle groups' live status lines.
  useAgents(session.id)
  const running = session.status === 'running' || session.status === 'starting'
  const waiting = session.status === 'waiting'
  const reduce = useReducedMotion()

  // The report file, polled like the plan document.
  const [doc, setDoc] = useState('')
  useEffect(() => {
    if (!session.planPath) return
    let alive = true
    const poll = async (): Promise<void> => {
      const content = await readFile(session.planPath!)
      if (alive && content !== null) setDoc(content)
    }
    void poll()
    const t = setInterval(() => void poll(), running ? 1500 : 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [session.planPath, running, readFile])

  const report = useMemo(() => parseReport(doc), [doc])
  const complete = report.status === 'complete'
  const hasBoard = board.angles.length > 0 || doc.trim().length > 0

  // Chat pane phases (render-time adjusts, same as Plan/Implementation): a
  // question forces it open, a run starting reopens it, and the run that
  // COMPLETES the report folds it — that run's deliverable is the report.
  // Later runs are answer-first follow-ups whose deliverable is the chat
  // answer, so they stay open.
  const [chatOpen, setChatOpen] = useState(true)
  const completeAtRunStart = useRef(complete)
  const [sawWaiting, setSawWaiting] = useState(waiting)
  if (waiting !== sawWaiting) {
    setSawWaiting(waiting)
    if (waiting) setChatOpen(true)
  }
  const [sawRunning, setSawRunning] = useState(running)
  if (running !== sawRunning) {
    setSawRunning(running)
    if (running) {
      completeAtRunStart.current = complete
      setChatOpen(true)
    } else if (!waiting && complete && !completeAtRunStart.current && !stopped) setChatOpen(false)
  }
  const collapsed = hasBoard && !chatOpen

  // A boarded angle group opens the agent's detail surface.
  const [openAgentId, setOpenAgentId] = useState<string | null>(null)
  const openAgent = openAgentId ? (sessions[openAgentId] ?? null) : null

  // Board/chat split in %, draggable 30–70, double-click resets.
  const containerRef = useRef<HTMLDivElement>(null)
  const [split, setSplit] = useState(50)
  const [dragging, setDragging] = useState(false)
  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    setDragging(true)
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      setSplit(Math.min(70, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100)))
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1">
      <AnimatePresence initial={false}>
        {hasBoard && (
          <motion.div
            key="board"
            initial={reduce ? false : { flexBasis: '0%', opacity: 0 }}
            animate={{ flexBasis: collapsed ? '100%' : `${split}%`, opacity: 1 }}
            transition={dragging || reduce ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT }}
            style={{ flexGrow: 0, flexShrink: 1 }}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-4 pl-4">
              <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                Research
              </span>
              {(board.sources > 0 || board.searches > 0) && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {board.sources} source{board.sources === 1 ? '' : 's'} · {board.searches}{' '}
                  search{board.searches === 1 ? '' : 'es'}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto select-text">
              <div className="mx-auto w-full max-w-3xl px-6 py-5">
                {doc.trim() && <ReportPane session={session} report={report} running={running} />}
                {board.angles.length > 0 && (
                  <div className={cn(doc.trim() && 'mt-6 border-t border-hairline pt-5')}>
                    {board.angles.map((angle) => (
                      <AngleGroup
                        key={angle.agentId}
                        angle={angle}
                        self={angle.agentId === session.id}
                        onOpen={() => setOpenAgentId(angle.agentId)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {hasBoard && !collapsed && (
        <div
          onPointerDown={startDrag}
          onDoubleClick={() => setSplit(50)}
          title="Drag to resize · double-click to reset"
          className={cn(
            'w-[3px] shrink-0 cursor-col-resize bg-hairline transition-colors hover:bg-border-strong',
            dragging && 'bg-border-strong'
          )}
        />
      )}

      {collapsed && (
        <button
          onClick={() => setChatOpen(true)}
          title="Show conversation"
          aria-label="Show conversation"
          className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-hairline pt-4 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <MessageSquare className="size-3.5" />
          <StatusDot status={session.status} />
        </button>
      )}
      {/* The chat pane stays MOUNTED while folded (hidden at its open
          width) so the transcript virtualizer keeps its measurements —
          same trick as Implementation's. */}
      <div
        inert={collapsed}
        style={collapsed ? { width: `${100 - split}%` } : undefined}
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          collapsed ? 'invisible absolute inset-y-0 right-0' : 'flex-1'
        )}
      >
        {hasBoard && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-1.5 pl-4">
            <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
              Conversation
            </span>
            <button
              onClick={() => setChatOpen(false)}
              title="Hide conversation"
              aria-label="Hide conversation"
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        )}
        {/* No minimap in the side pane — it overlaps the text there. */}
        <Transcript sessionId={session.id} minimap={!hasBoard} />
        <FleetPulseLine sessionId={session.id} />
        <WorkingStrip sessionId={session.id} />
        <PromptBar compact={hasBoard} narrow={hasBoard} />
      </div>

      <AnimatePresence>
        {openAgent && (
          <AgentDetail
            key={openAgent.id}
            agent={openAgent}
            parent={session}
            onClose={() => setOpenAgentId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** The report: a pin (title + state) while it is being researched and
 *  written, the full document rendered inline once complete. */
function ReportPane({
  session,
  report,
  running
}: {
  session: SessionMeta
  report: Report
  running: boolean
}): React.JSX.Element {
  const openFileRef = useApp((s) => s.openFileRef)
  const complete = report.status === 'complete'
  return (
    <div>
      <button
        onClick={() => session.planPath && openFileRef(session.planPath)}
        title="Open the report file"
        className="group flex w-full items-baseline gap-2 text-left"
      >
        <p className="min-w-0 truncate text-[15px] leading-snug font-medium tracking-[-0.01em] group-hover:underline">
          {report.title ?? session.title}
        </p>
        {!complete && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {running && <Spinner className="size-3" />}
            in progress
          </span>
        )}
      </button>
      {complete ? (
        <div className="mt-2 text-[13px]">
          <MarkdownText text={report.body} streaming={false} />
        </div>
      ) : (
        report.summary && (
          <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{report.summary}</p>
        )
      )}
    </div>
  )
}

/** What an angle's agent is doing right now, from its latest activity. */
function angleStatus(blocks: Block[] | undefined): string {
  const last = blocks?.at(-1)
  if (last && (last.kind === 'assistant' || last.kind === 'thinking')) return 'synthesizing'
  const tool = blocks?.findLast((b) => b.kind === 'tool')
  const name = tool?.kind === 'tool' ? tool.name : ''
  if (/fetch/i.test(name)) return 'reading'
  if (/search/i.test(name) || !tool) return 'searching'
  return 'reading'
}

/** One research angle: the agent's label, a live status line while it
 *  works, and its queries with sources streaming in beneath. */
function AngleGroup({
  angle,
  self,
  onOpen
}: {
  angle: Angle
  self: boolean
  onOpen: () => void
}): React.JSX.Element {
  const agent = useApp((s) => s.sessions[angle.agentId])
  const blocks = useApp((s) => s.blocks[angle.agentId])
  const live = agent?.status === 'running' || agent?.status === 'starting'
  const label = self ? 'Direct research' : (agent?.title ?? angle.label)
  return (
    <div className="mb-5 last:mb-0">
      <button
        onClick={onOpen}
        disabled={self}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left',
          !self && 'transition-colors hover:bg-accent/40'
        )}
      >
        <span className="min-w-0 truncate text-[12.5px] font-medium">{label}</span>
        {live && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {angleStatus(blocks)}…
          </span>
        )}
        {!self && (
          <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
      {angle.queries.map((q, i) => (
        <div key={i}>
          {q.query && (
            <div className="mt-1.5 flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
              <Search className="size-3 shrink-0" />
              <span className="truncate">{q.query}</span>
            </div>
          )}
          {q.sources.map((src) => (
            <SourceLink key={src.url} src={src} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** One consulted source: favicon, name, and the address small at right. */
function SourceLink({ src }: { src: SourceRow }): React.JSX.Element {
  const host = hostOf(src.url)
  return (
    <button
      onClick={() => window.open(src.url)}
      title={src.url}
      className="flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left transition-colors hover:bg-accent/40"
    >
      <Favicon url={src.url} />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{src.title ?? host}</span>
      <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground/60">
        {src.title ? src.url.replace(/^https?:\/\/(www\.)?/, '') : ''}
      </span>
    </button>
  )
}
