/**
 * The desktop transcript measured on a 2,000-row chat (the same shape the
 * iOS test server seeds): open, scroll up through all of it, a streamed
 * turn, and the heap. Runs the BUILT tree (electron-vite preview) under a
 * scratch userData on a display of its own (xvfb-run where there is no
 * display), traces over CDP, and prints one table plus a JSON file under
 * /tmp/tc-transcript-measure/<label>.json. Nothing here touches the user's
 * data. Build the tree with TEMP_CODE_PROFILE=1 (electron-vite build): the
 * facade the script drives (window.__app) exists only in dev and profiling builds.
 *
 *   bun run script:measure-transcript-seed            # the database, once
 *   bun scripts/measure-transcript.ts --label before  # one pass (--tree <dir> for another build)
 *
 * Numbers reported:
 *   open     a cold mount: the long thread selected, the page reloaded; ms
 *            from the page's time origin to `tc:transcript-blocks` and to
 *            the next Paint, main-thread ms up to that paint, the longest
 *            task, mounted rows and DOM nodes. Both arms pay the same boot.
 *   switch   a warm tab switch back to the long thread: ms to first paint.
 *   scroll   frame times while scrolling to the top of the whole thread
 *            (p50 / p95 / max, frames over 16.7 ms and 50 ms), how many
 *            "Load earlier" pages it took, main-thread ms over the pass.
 *   feed     a 480-row streamed turn (8 s at 60 rows/s): main-thread ms per
 *            appended row, p95 task, Layout ms per row.
 *   heap     used JS heap after a collection, at each stage.
 */
import { existsSync, writeFileSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { attach, REPO, sleep, type Cdp } from './lib/packagedApp'

const ROOT = process.env.TC_MEASURE_ROOT ?? '/tmp/tc-transcript-measure'
const USER_DATA = join(ROOT, 'userData')
const DEBUG_PORT = Number(process.env.TC_MEASURE_DEBUG_PORT ?? 9241)
const SESSION = 'measure-long'
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const label = flag('--label') ?? 'run'
/** One phase alone (open | scroll | feed), for a quick look. */
const only = flag('--only')
const tree = flag('--tree') ?? REPO

// ── measure ────────────────────────────────────────────────────────────────
type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; cat: string; args?: Record<string, unknown> }

async function measure(): Promise<void> {
  if (!existsSync(join(USER_DATA, 'temp-code.db'))) throw new Error('run --seed first')
  if (!existsSync(join(tree, 'out', 'renderer', 'index.html'))) throw new Error(`no build under ${tree}/out`)
  if (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(() => true, () => false))
    throw new Error(`port ${DEBUG_PORT} is in use (an earlier instance still up?)`)
  const logPath = join(ROOT, `${label}.app.log`)
  const fd = openSync(logPath, 'w')
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    TEMP_CODE_USER_DATA: USER_DATA,
    TEMP_CODE_DEBUG_PORT: String(DEBUG_PORT),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(ROOT, 'aliax')
  })
  const bin = join(tree, 'node_modules', '.bin', 'electron-vite')
  const cmd = env.DISPLAY ? [bin, 'preview', '--skipBuild'] : ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24', bin, 'preview', '--skipBuild']
  const proc = Bun.spawn(cmd, { cwd: tree, env, stdout: fd, stderr: fd })
  const results: Record<string, unknown> = { label, tree, at: new Date().toISOString() }
  try {
    const cdp = await attach(DEBUG_PORT, 120_000)
    await cdp.send('HeapProfiler.enable')
    await waitFor(cdp, 'typeof window.__app?.openSession === "function"', 60_000)
    await cdp.eval(`window.__app.openSession('measure-short')`)
    await sleep(1500)
    results.heapIdleMb = await heapMb(cdp)

    if (!only || only === 'open') {
      // open, cold: the long thread is the selected one, the page reloads, and
      // the transcript mounts from nothing. Both arms pay the same boot.
      await cdp.eval(`window.__app.openSession(${JSON.stringify(SESSION)})`)
      await sleep(1500)
      const events = await traced(cdp, async () => {
        await cdp.send('Page.enable')
        await cdp.send('Page.reload')
        await sleep(1000)
        await waitFor(cdp, 'typeof window.__app?.openSession === "function"', 60_000)
        await waitFor(cdp, `performance.getEntriesByName('tc:transcript-blocks').length > 0`, 60_000)
        await sleep(2500)
      })
      const blocksAt = await cdp.eval<number>(`performance.getEntriesByName('tc:transcript-blocks')[0].startTime`)
      results.open = {
        ...analyseOpen(events, blocksAt),
        rowsMounted: await cdp.eval<number>(COUNT_ROWS),
        domNodes: await cdp.eval<number>(COUNT_NODES),
        heapMb: await heapMb(cdp)
      }

      // switch, warm: from the short thread back to the long one's kept pane
      await cdp.eval(`window.__app.openSession('measure-short')`)
      await sleep(1500)
      const switched = await traced(cdp, async () => {
        await cdp.eval(`(performance.mark('tc:measure-switch'), window.__app.openSession(${JSON.stringify(SESSION)}))`)
        await sleep(2000)
      })
      results.switch = analyseSwitch(switched)
    }

    if (!only || only === 'scroll') {
      await cdp.eval(`window.__app.openSession(${JSON.stringify(SESSION)})`)
      await sleep(1500)
      // scroll to the top of everything
      const events = await traced(cdp, async () => {
        results.scroll = await cdp.eval<{ frames: number[]; loads: number; rows: number; reachedTop: boolean }>(SCROLL_SCRIPT)
      })
      const scrollStats = analyseWindow(events, 'tc:measure-scroll-start', 'tc:measure-scroll-end')
      const frames = (results.scroll as { frames: number[] }).frames
      results.scroll = {
        ...(results.scroll as object),
        frames: undefined,
        ...frameStats(frames),
        ...scrollStats,
        rowsMounted: await cdp.eval<number>(COUNT_ROWS),
        domNodes: await cdp.eval<number>(COUNT_NODES),
        heapMb: await heapMb(cdp)
      }

      // back down through everything, one 400px step per frame
      const backEvents = await traced(cdp, async () => {
        results.scrollBack = await cdp.eval<{ frames: number[] }>(SCROLL_BACK_SCRIPT)
      })
      const backStats = analyseWindow(backEvents, 'tc:measure-back-start', 'tc:measure-back-end')
      results.scrollBack = { ...frameStats((results.scrollBack as { frames: number[] }).frames), ...backStats }
    }

    if (!only || only === 'feed') {
      // at the bottom of the long thread, a streamed turn
      await cdp.eval(`window.__app.openSession(${JSON.stringify(SESSION)})`)
      await sleep(1000)
      await cdp.eval(`(${SHOWN}.scrollTop = 1e9, true)`)
      await sleep(1500)
      const events = await traced(cdp, async () => {
        await cdp.eval(`(window.__app.profile.start(), performance.mark('tc:measure-feed-start'))`)
        const fed = await cdp.eval<{ event: number; ms: number }>(`window.__app.feed({ sessionId: ${JSON.stringify(SESSION)}, seconds: 8, perSecond: 60, toolEvery: 40 })`)
        await cdp.eval(`performance.mark('tc:measure-feed-end')`)
        results.feedRows = fed.event
        results.feedProfile = await cdp.eval(`window.__app.profile.stop()`)
      })
      const feed = analyseWindow(events, 'tc:measure-feed-start', 'tc:measure-feed-end')
      const rows = results.feedRows as number
      results.feed = {
        rows,
        ...feed,
        mainMsPerRow: round(feed.mainMs / rows),
        layoutMsPerRow: round(feed.layoutMs / rows),
        heapMb: await heapMb(cdp)
      }
    }
    await cdp.eval('(window.api.app.confirmQuit(), true)').catch(() => undefined)
    await Promise.race([proc.exited, sleep(10_000)])
  } finally {
    proc.kill('SIGKILL')
    await killMine()
  }
  writeFileSync(join(ROOT, `${label}.json`), JSON.stringify(results, null, 2))
  print(results)
}

/** The transcript on screen: a parked pane keeps its own mounted behind it. */
const SHOWN = `[...document.querySelectorAll('.agent-transcript')].find((e) => e.clientHeight > 0 && !e.closest('.tab-parked'))`
const COUNT_ROWS = `${SHOWN}.querySelectorAll('[data-block]').length`
const COUNT_NODES = `${SHOWN}.querySelectorAll('*').length`

const SCROLL_SCRIPT = `new Promise((done) => {
  const el = ${SHOWN};
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
  const frames = [];
  let loads = 0, last = performance.now(), idle = 0, waiting = false, rowsBefore = 0;
  performance.mark('tc:measure-scroll-start');
  const step = (now) => {
    frames.push(now - last); last = now;
    const rows = el.querySelectorAll('[data-block]').length;
    if (waiting) {
      if (rows !== rowsBefore) waiting = false;
      else if (frames.length > 6000) return finish(false);
      else return requestAnimationFrame(step);
    }
    if (el.scrollTop > 0) { el.scrollTop = Math.max(0, el.scrollTop - 400); idle = 0; return requestAnimationFrame(step); }
    const button = [...el.querySelectorAll('button')].find((b) => /Load earlier/.test(b.textContent));
    if (button) { loads += 1; rowsBefore = rows; waiting = true; button.click(); return requestAnimationFrame(step); }
    if (++idle < 10) return requestAnimationFrame(step);
    finish(true);
  };
  const finish = (reachedTop) => {
    performance.mark('tc:measure-scroll-end');
    done({ frames: frames.slice(1), loads, rows: el.querySelectorAll('[data-block]').length, reachedTop });
  };
  requestAnimationFrame(step);
})`

/** Every process this run launched (Electron's helpers included): the ones
 *  whose environment names our userData. Linux only, which is where this runs. */
async function killMine(): Promise<void> {
  const { readdirSync, readFileSync } = await import('node:fs')
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').includes(`TEMP_CODE_USER_DATA=${USER_DATA}\0`)) process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* gone, or not ours to read */
    }
  }
}

const SCROLL_BACK_SCRIPT = `new Promise((done) => {
  const el = ${SHOWN};
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
  const frames = [];
  let last = performance.now();
  performance.mark('tc:measure-back-start');
  const step = (now) => {
    frames.push(now - last); last = now;
    const max = el.scrollHeight - el.clientHeight;
    if (el.scrollTop < max - 1) { el.scrollTop = Math.min(max, el.scrollTop + 400); return requestAnimationFrame(step); }
    performance.mark('tc:measure-back-end');
    done({ frames: frames.slice(1) });
  };
  requestAnimationFrame(step);
})`

async function waitFor(cdp: Cdp, expression: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await cdp.eval<boolean>(expression).catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${expression}`)
}

async function heapMb(cdp: Cdp): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  await sleep(300)
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return round(usedSize / 1048576)
}

async function traced(cdp: Cdp, run: () => Promise<void>): Promise<TraceEvent[]> {
  const events: TraceEvent[] = []
  const done = new Promise<void>((res) => cdp.on('Tracing.tracingComplete', () => res()))
  cdp.on('Tracing.dataCollected', (p) => events.push(...((p as { value: TraceEvent[] }).value)))
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,toplevel,v8.execute',
    transferMode: 'ReportEvents'
  })
  await run()
  await cdp.send('Tracing.end')
  await done
  return events
}

/** The renderer's main thread: where the page's own `tc:` marks land. */
function mainThread(events: TraceEvent[]): { pid: number; tid: number } {
  const mark = events.find((e) => typeof e.name === 'string' && e.name.startsWith('tc:') && e.cat.includes('blink.user_timing'))
  return mark ? { pid: mark.pid, tid: mark.tid } : { pid: 0, tid: 0 }
}

/** Top-level tasks on a thread: devtools' RunTask where the trace has it,
 *  else the scheduler's own (the two nest, so never both). */
function taskName(events: TraceEvent[], pid: number, tid: number): string {
  return events.some((e) => e.pid === pid && e.tid === tid && e.name === 'RunTask') ? 'RunTask' : 'ThreadControllerImpl::RunTask'
}

function markTs(events: TraceEvent[], name: string): number | undefined {
  return events.find((e) => e.name === name && e.cat.includes('blink.user_timing'))?.ts
}

/** `blocksAt`: the blocks mark's startTime, ms since the reloaded page's
 *  time origin, which places that origin on the trace clock. */
function analyseOpen(events: TraceEvent[], blocksAt: number) {
  const { pid, tid } = mainThread(events)
  const blocks = markTs(events, 'tc:transcript-blocks')
  if (blocks === undefined) return { error: 'marks missing' }
  const origin = blocks - blocksAt * 1000
  const paint = events.find((e) => e.pid === pid && e.tid === tid && e.name === 'Paint' && e.ts > blocks)
  const firstPaintMs = paint ? round((paint.ts + (paint.dur ?? 0) - origin) / 1000) : undefined
  const end = paint ? paint.ts + (paint.dur ?? 0) : blocks
  return { blocksMs: round(blocksAt), firstPaintMs, ...taskStats(events, pid, tid, origin, end + 1000) }
}

/** A warm switch: from the mark to the first paint after the pane came forward. */
function analyseSwitch(events: TraceEvent[]) {
  const { pid, tid } = mainThread(events)
  const at = markTs(events, 'tc:measure-switch')
  if (at === undefined) return { error: 'marks missing' }
  const paint = events.find((e) => e.pid === pid && e.tid === tid && e.name === 'Paint' && e.ts > at)
  const end = paint ? paint.ts + (paint.dur ?? 0) : at
  return { firstPaintMs: paint ? round((end - at) / 1000) : undefined, ...taskStats(events, pid, tid, at, end + 1000) }
}

function analyseWindow(events: TraceEvent[], start: string, end: string) {
  const { pid, tid } = mainThread(events)
  const a = markTs(events, start)
  const b = markTs(events, end)
  if (a === undefined || b === undefined) return { error: 'marks missing', mainMs: 0, layoutMs: 0, taskP95: 0, longestTaskMs: 0, tasksOver50: 0, wallMs: 0 }
  return taskStats(events, pid, tid, a, b)
}

function taskStats(events: TraceEvent[], pid: number, tid: number, from: number, to: number) {
  const tasks: number[] = []
  const task = taskName(events, pid, tid)
  const byName = new Map<string, number>()
  let layout = 0
  for (const e of events) {
    if (e.pid !== pid || e.tid !== tid || e.ph !== 'X' || e.ts < from || e.ts > to) continue
    if (e.name === task) tasks.push((e.dur ?? 0) / 1000)
    else {
      byName.set(e.name, (byName.get(e.name) ?? 0) + (e.dur ?? 0) / 1000)
      if (e.name === 'Layout' || e.name === 'UpdateLayoutTree') layout += (e.dur ?? 0) / 1000
    }
  }
  const topEvents = Object.fromEntries([...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, ms]) => [n, round(ms)]))
  return {
    topEvents,
    wallMs: round((to - from) / 1000),
    mainMs: round(tasks.reduce((s, t) => s + t, 0)),
    layoutMs: round(layout),
    taskP95: round(pct(tasks, 0.95)),
    longestTaskMs: round(Math.max(0, ...tasks)),
    tasksOver50: tasks.filter((t) => t > 50).length
  }
}

function frameStats(frames: number[]) {
  return {
    frameCount: frames.length,
    frameP50: pct(frames, 0.5),
    frameP95: pct(frames, 0.95),
    frameMax: frames.length ? round(Math.max(...frames)) : 0,
    framesOver17: frames.filter((f) => f > 17).length,
    framesOver50: frames.filter((f) => f > 50).length
  }
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))])
}
function round(n: number): number {
  return Math.round(n * 100) / 100
}

function print(r: Record<string, unknown>): void {
  console.log(`\n== transcript measurement: ${r.label} ==`)
  console.log(JSON.stringify(r, null, 2))
}

await measure()
