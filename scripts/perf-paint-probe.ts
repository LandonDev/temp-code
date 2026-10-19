#!/usr/bin/env bun
/**
 * Renderer paint and timer probe over CDP, for an isolated dev instance.
 *
 *   bun scripts/perf-paint-probe.ts --port 9224 --seconds 20 --label before-css
 *   bun scripts/perf-paint-probe.ts --port 9224 --census [--settle 10]
 *   bun scripts/perf-paint-probe.ts --port 9224 --reload
 *
 * Measure: counts `LayerTree.layerPainted` (one per layer paint) and
 * `LayerTree.layerTreeDidChange` (one per compositor commit) over the
 * window and diffs `Performance.getMetrics` at both ends. Prints one table
 * and one `PROBE {...}` JSON line tagged with --label. The display's frame
 * rate is sampled once with requestAnimationFrame BEFORE the window opens,
 * never during it: a rAF loop would itself force a main frame every vsync.
 *
 * Census: wraps setInterval/clearInterval and setTimeout/clearTimeout on the
 * next document, reloads the page, waits --settle seconds for the operator's
 * view to come back, then lists every live interval and every pending
 * timeout of 250ms or more with the call site that made it.
 *
 * Uses the global WebSocket (bun), never the `ws` package. Never point it at
 * the installed app: LayerTree.enable snapshots layers on every commit.
 */

type Target = { type: string; title: string; url: string; webSocketDebuggerUrl?: string }

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const PORT = Number(opt('port', '9224'))
const SECONDS = Number(opt('seconds', '20'))
const LABEL = opt('label', '')
const SETTLE = Number(opt('settle', '10'))
const CENSUS = flag('census')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (s: string): void => console.log(s)

async function pageTarget(): Promise<Target> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Target[]
  const pages = list.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      (t.url.startsWith('http://localhost:5173') || t.url.includes('/renderer/index.html'))
  )
  if (pages.length === 0) {
    const seen = list.map((t) => `${t.type} ${t.url}`).join('\n  ')
    throw new Error(`no renderer page on ${PORT}; targets:\n  ${seen}`)
  }
  if (pages.length > 1) log(`note: ${pages.length} renderer pages, taking the first`)
  return pages[0]
}

class Cdp {
  private ws: WebSocket
  private next = 1
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private handlers = new Map<string, (params: unknown) => void>()
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.rej(new Error(msg.error.message))
        else p.res(msg.result)
        return
      }
      if (msg.method) this.handlers.get(msg.method)?.(msg.params)
    })
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => res(new Cdp(ws)))
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')))
    })
  }
  on(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })) as {
      result: { value?: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  close(): void {
    this.ws.close()
  }
}

type Metric = { name: string; value: number }
const metricsOf = async (cdp: Cdp): Promise<Record<string, number>> => {
  const r = (await cdp.send('Performance.getMetrics')) as { metrics: Metric[] }
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))
}

/** Frames per second as the page sees them: 60 rAF callbacks timed, null when the window is hidden. */
const sampleHz = (cdp: Cdp): Promise<number | null> =>
  cdp.eval<number | null>(`new Promise((resolve) => {
    let n = 0, t0 = 0;
    const done = setTimeout(() => resolve(null), 5000);
    const step = (t) => {
      if (n === 0) t0 = t;
      if (++n > 60) { clearTimeout(done); resolve(Math.round(60000 / (t - t0))); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`)

const COUNTS = ['LayoutCount', 'RecalcStyleCount'] as const
const DURATIONS = [
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'ThreadTime',
  'ProcessTime'
] as const

async function measure(cdp: Cdp, hz: number | null): Promise<void> {
  let painted = 0
  let commits = 0
  cdp.on('LayerTree.layerPainted', () => painted++)
  cdp.on('LayerTree.layerTreeDidChange', () => commits++)
  await cdp.send('Performance.enable')
  await cdp.send('LayerTree.enable')
  await sleep(500) // let the enable traffic settle before the window opens
  const before = await metricsOf(cdp)
  const t0 = Date.now()
  await sleep(SECONDS * 1000)
  const after = await metricsOf(cdp)
  const elapsed = (Date.now() - t0) / 1000
  await cdp.send('LayerTree.disable')
  await cdp.send('Performance.disable')

  const delta = (k: string): number => (after[k] ?? 0) - (before[k] ?? 0)
  const rows: [string, string, string][] = [
    ['layerPainted', String(painted), (painted / elapsed).toFixed(1) + '/s'],
    ['layerTreeDidChange', String(commits), (commits / elapsed).toFixed(1) + '/s']
  ]
  for (const k of COUNTS) rows.push([k, String(delta(k)), (delta(k) / elapsed).toFixed(1) + '/s'])
  for (const k of DURATIONS)
    rows.push([k, delta(k).toFixed(3) + 's', ((delta(k) / elapsed) * 100).toFixed(1) + '% of wall'])

  const w = [22, 14, 16]
  log('')
  log(`${LABEL || 'probe'} — ${elapsed.toFixed(1)}s window, display ${hz ?? '?'} Hz`)
  log(['metric', 'total', 'rate'].map((h, i) => h.padEnd(w[i])).join(''))
  for (const r of rows) log(r.map((c, i) => c.padEnd(w[i])).join(''))
  const json = {
    label: LABEL,
    port: PORT,
    seconds: Number(elapsed.toFixed(1)),
    hz,
    painted,
    paintedPerSec: Number((painted / elapsed).toFixed(1)),
    commits,
    commitsPerSec: Number((commits / elapsed).toFixed(1)),
    ...Object.fromEntries(
      [...COUNTS, ...DURATIONS].map((k) => [k, Number(delta(k).toFixed(3))])
    )
  }
  log(`PROBE ${JSON.stringify(json)}`)
}

/** Installed before any page script: keeps live maps of intervals and pending long timeouts. */
const TIMER_WRAP = `(() => {
  const intervals = new Map();
  const timeouts = new Map();
  const site = () => {
    const frames = (new Error().stack || '').split('\\n').slice(2);
    const f = frames.find((l) => !l.includes('__tc_timer')) || frames[0] || '';
    return f.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+\\//g, '');
  };
  const si = window.setInterval, ci = window.clearInterval;
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setInterval = function __tc_timer(fn, ms, ...rest) {
    const id = si.call(window, fn, ms, ...rest);
    intervals.set(id, { ms: ms ?? 0, fn: String(fn).slice(0, 80), at: site() });
    return id;
  };
  window.clearInterval = function __tc_timer(id) { intervals.delete(id); return ci.call(window, id); };
  window.setTimeout = function __tc_timer(fn, ms, ...rest) {
    let id;
    const wrapped = typeof fn === 'function' ? function () { timeouts.delete(id); return fn.apply(this, arguments); } : fn;
    id = st.call(window, wrapped, ms, ...rest);
    if ((ms ?? 0) >= 250) timeouts.set(id, { ms: ms ?? 0, fn: String(fn).slice(0, 80), at: site() });
    return id;
  };
  window.clearTimeout = function __tc_timer(id) { timeouts.delete(id); return ct.call(window, id); };
  window.__tcTimers = () => ({ intervals: [...intervals.values()], timeouts: [...timeouts.values()] });
})();`

type TimerRow = { ms: number; fn: string; at: string }

async function census(cdp: Cdp): Promise<void> {
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TIMER_WRAP })
  const loaded = new Promise<void>((r) => cdp.on('Page.loadEventFired', () => r()))
  await cdp.send('Page.reload')
  await loaded
  log(`reloaded; settling ${SETTLE}s for the view to come back`)
  await sleep(SETTLE * 1000)
  const live = await cdp.eval<{ intervals: TimerRow[]; timeouts: TimerRow[] }>(
    'JSON.parse(JSON.stringify(window.__tcTimers()))'
  )
  const print = (title: string, rows: TimerRow[]): void => {
    log('')
    log(`${title}: ${rows.length}`)
    for (const r of rows.sort((a, b) => a.ms - b.ms))
      log(`  ${String(r.ms).padStart(6)}ms  ${r.at}  ${r.fn.replace(/\s+/g, ' ')}`)
  }
  print('live intervals', live.intervals)
  print('pending timeouts ≥250ms', live.timeouts)
  log(
    `CENSUS ${JSON.stringify({
      label: LABEL,
      intervals: live.intervals.length,
      timeouts: live.timeouts.length,
      intervalMs: live.intervals.map((r) => r.ms).sort((a, b) => a - b)
    })}`
  )
}

async function reload(cdp: Cdp): Promise<void> {
  await cdp.send('Page.enable')
  const loaded = new Promise<void>((r) => cdp.on('Page.loadEventFired', () => r()))
  await cdp.send('Page.reload')
  await loaded
  log('reloaded')
}

const page = await pageTarget()
log(`page: ${JSON.stringify(page.title)} ${page.url}`)
const cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
try {
  if (flag('reload')) {
    await reload(cdp)
  } else if (CENSUS) {
    await census(cdp)
  } else {
    const hz = await sampleHz(cdp)
    if (hz === null) log('warning: requestAnimationFrame did not run; the window is hidden or occluded')
    await measure(cdp, hz)
  }
} finally {
  cdp.close()
}
