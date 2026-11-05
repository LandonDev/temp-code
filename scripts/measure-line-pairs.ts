/**
 * Measures how the words on one line sit beside each other, in a real browser.
 *
 *   bun scripts/measure-line-pairs.ts                # the transcript's fixtures
 *   bun scripts/measure-line-pairs.ts <module>#<Export> …
 *
 * Each target renders through scripts/ui-preview.ts (its fixtures, dark) on a
 * stylesheet compiled from src/renderer/src/index.css as it stands, so an edit
 * reads at once with no electron-vite build. A headless Chromium loads each
 * page and, for every visible text node, reads its box and its baseline (a
 * zero-size inline-block probe set before the node: its top is the baseline).
 * Text nodes that follow each other on one visual line form a line; each pair
 * prints its gap (the later node's left edge less the earlier's right edge)
 * and its baseline delta.
 *
 * The rules (docs/DESIGN.md "Typography and text hierarchy"): two words on
 * one line share a baseline (within 0.5px), and a word, its detail, a count
 * and a time sit 4px apart (±1; a space in the text reads about 3.5px, and
 * words inside one sentence touch). A gap of 12px or more is a column a
 * spacer pushed apart, not a pair; glyphs and chevrons are no text and never
 * measured. Exits 1 when a rule fails, 0 with one line when no browser is
 * found.
 *
 * The browser: TC_CHROME, else the newest Playwright chrome-headless-shell
 * under ~/.cache/ms-playwright, else the repo's Electron (under xvfb-run when
 * there is no display).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const work = '/tmp/measure-line-pairs'

/** The fixtures the transcript's lines are judged on (plan UI-22). */
export const TARGETS = [
  'src/renderer/src/surfaces/transcript/WorkingLine.tsx#TurnLine',
  'src/renderer/src/surfaces/transcript/TurnEnd.tsx#WatchingLine',
  'src/renderer/src/surfaces/CompactionCard.tsx#CompactionCard',
  'src/renderer/src/surfaces/transcript/ActionGroup.tsx#ActionGroup',
  'src/renderer/src/surfaces/transcript/ThinkingRow.tsx#ActivityThinkingRow',
  'src/renderer/src/components/ui/status.tsx#StatusMark',
  'src/renderer/src/surfaces/threads/master/BatchFoot.tsx#BatchFoot',
  'src/renderer/src/surfaces/threads/master/MasterRow.tsx#MasterRowView',
  'src/renderer/src/surfaces/threads/ActivitySection.tsx#ActivityRows',
  'src/renderer/src/components/ui/task-list.tsx#TaskList',
  'src/renderer/src/surfaces/threads/fleet/AgentRow.tsx#AgentRowView',
]

export type Item = { t: string; x: number; r: number; base: number }
export type Line = { fixture: string; items: Item[] }
export type Finding = { fixture: string; pair: string; gap: number; delta: number; rule: 'baseline' | 'gap' }

/** A pair breaks a rule: baselines more than 0.5px apart, or a gap between a
 *  space's width and a column's (5 to 12px) where 4 ±1 is the rule. Two
 *  texts 12px or more apart are columns, judged by neither. */
export function judge(lines: Line[]): Finding[] {
  const findings: Finding[] = []
  for (const { fixture, items } of lines) {
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]
      const b = items[i]
      const gap = Math.round(b.x - a.r)
      const delta = +(b.base - a.base).toFixed(1)
      const pair = `"${a.t}" → "${b.t}"`
      if (gap >= 12) continue
      if (Math.abs(delta) > 0.5) findings.push({ fixture, pair, gap, delta, rule: 'baseline' })
      else if (gap > 5) findings.push({ fixture, pair, gap, delta, rule: 'gap' })
    }
  }
  return findings
}

/** Runs in the page: the visible text nodes of each fixture, grouped into
 *  visual lines, written to <pre id="MEASURE"> as JSON. */
const MEASURE = `<script>
(async () => {
  await document.fonts.ready
  // A fade in flight would read as hidden: every animation with an end is
  // finished first (the shimmer and the working mark loop and stay).
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish()
  }
  const hidden = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') return true
      if (e.matches('[data-shimmer],[aria-hidden=true],.sr-only,.preview-label,.preview-themes')) return true
    }
    return false
  }
  const lines = []
  for (const section of document.querySelectorAll('.preview-fixture')) {
    const fixture = section.querySelector('.preview-label')?.textContent ?? ''
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT)
    const items = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent.trim()
      if (!text || hidden(node.parentElement)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()].filter((r) => r.width > 0)
      if (rects.length !== 1) continue
      const rect = rects[0]
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
      node.parentNode.insertBefore(probe, node)
      const base = probe.getBoundingClientRect().top
      probe.remove()
      items.push({ t: text.slice(0, 32), x: rect.left, r: rect.right, top: rect.top, bottom: rect.bottom, base })
    }
    let line = []
    for (const item of items) {
      const prev = line[line.length - 1]
      const centre = (item.top + item.bottom) / 2
      if (prev && centre > prev.top && centre < prev.bottom && item.x >= prev.r - 1) line.push(item)
      else {
        if (line.length > 1) lines.push({ fixture, items: line })
        line = [item]
      }
    }
    if (line.length > 1) lines.push({ fixture, items: line })
  }
  const pre = document.createElement('pre')
  pre.id = 'MEASURE'
  pre.textContent = JSON.stringify(lines.map(({ fixture, items }) => ({ fixture, items: items.map(({ t, x, r, base }) => ({ t, x, r, base })) })))
  document.body.append(pre)
})()
</script>`

function headlessShell(): string | null {
  if (process.env.TC_CHROME) return process.env.TC_CHROME
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return null
  const dirs = readdirSync(cache).filter((dir) => dir.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
  for (const dir of dirs) {
    for (const sub of ['chrome-headless-shell-linux64', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const binary = join(cache, dir, sub, 'chrome-headless-shell')
      if (existsSync(binary)) return binary
    }
  }
  return null
}

function electronBinary(): string | null {
  const path = join(root, 'node_modules/electron/path.txt')
  if (!existsSync(path)) return null
  const binary = join(root, 'node_modules/electron/dist', spawnSync('cat', [path], { encoding: 'utf8' }).stdout.trim())
  return existsSync(binary) ? binary : null
}

/** The page's DOM once its script has written the measurement. */
async function dumpDom(page: string): Promise<string> {
  const shell = headlessShell()
  if (shell) {
    const run = spawnSync(shell, ['--headless', '--no-sandbox', '--disable-gpu', '--window-size=900,2000',
      '--virtual-time-budget=4000', '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 60_000 })
    return run.stdout
  }
  const electron = electronBinary()
  if (!electron) return ''
  const main = join(work, 'electron-main.cjs')
  await writeFile(main, `const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 2000 })
  await win.loadFile(process.argv[process.argv.length - 1])
  for (let i = 0; i < 100; i++) {
    const html = await win.webContents.executeJavaScript('document.getElementById("MEASURE") ? document.documentElement.outerHTML : ""')
    if (html) { process.stdout.write(html); break }
    await new Promise((done) => setTimeout(done, 100))
  }
  app.quit()
})\n`)
  const args = [main, page]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const display = process.platform === 'linux' && !process.env.DISPLAY
  const run = display
    ? spawnSync('xvfb-run', ['-a', electron, ...args], { encoding: 'utf8', env, timeout: 60_000 })
    : spawnSync(electron, args, { encoding: 'utf8', env, timeout: 60_000 })
  return run.stdout
}

/** index.css compiled as the renderer's build would, into work/out/renderer/assets. */
async function compileStylesheet(): Promise<void> {
  const { compile } = await import('@tailwindcss/node')
  const { Scanner } = await import('@tailwindcss/oxide')
  const entry = join(root, 'src/renderer/src/index.css')
  const compiler = await compile(await readFile(entry, 'utf8'), { base: dirname(entry), onDependency: () => {} })
  const sources = compiler.root === 'none' ? [] : compiler.root === null
    ? [{ base: join(root, 'src/renderer'), pattern: '**/*', negated: false }]
    : [{ ...compiler.root, negated: false }]
  const css = compiler.build(new Scanner({ sources: [...sources, ...compiler.sources] }).scan())
  const assets = join(work, 'out/renderer/assets')
  await mkdir(assets, { recursive: true })
  await writeFile(join(assets, 'index.css'), css)
}

function decode(html: string): string {
  return html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

async function main(): Promise<void> {
  if (!headlessShell() && !electronBinary()) {
    console.log('measure-line-pairs: no headless Chromium (TC_CHROME, ~/.cache/ms-playwright) or Electron found; nothing measured.')
    return
  }
  await compileStylesheet()
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS
  const all: Line[] = []
  for (const target of targets) {
    const [module, name] = target.split('#')
    const preview = spawnSync(process.execPath, [join(root, 'scripts/ui-preview.ts'), `${resolve(root, module)}#${name}`, '--width', '640'],
      { cwd: work, encoding: 'utf8' })
    const page = preview.stdout.split('\n').find((line) => line.endsWith('.html') && !line.endsWith('.light.html'))
    if (preview.status !== 0 || !page) {
      console.log(`✗ ${target}: ui-preview failed\n${preview.stderr.trim()}`)
      process.exitCode = 1
      continue
    }
    const measured = join(work, `${basename(page, '.html')}.measure.html`)
    await writeFile(measured, (await readFile(page, 'utf8')).replace('</body>', `${MEASURE}</body>`))
    const match = (await dumpDom(measured)).match(/<pre id="MEASURE">([\s\S]*?)<\/pre>/)
    if (!match) {
      console.log(`✗ ${target}: the page wrote no measurement`)
      process.exitCode = 1
      continue
    }
    const lines = (JSON.parse(decode(match[1])) as Line[]).map((line) => ({ ...line, fixture: `${name} / ${line.fixture}` }))
    all.push(...lines)
    console.log(`\n${target}`)
    for (const { fixture, items } of lines) {
      const pairs = items.map((item, i) => i === 0 ? `"${item.t}"`
        : `[gap ${Math.round(item.x - items[i - 1].r)} Δ ${(item.base - items[i - 1].base).toFixed(1)}] "${item.t}"`)
      console.log(`  ${fixture.slice(name.length + 3)}: ${pairs.join(' ')}`)
    }
  }
  const findings = judge(all)
  console.log(findings.length ? `\n${findings.length} pairs break the rules:` : '\nEvery pair shares its baseline and sits 4px apart.')
  for (const f of findings) console.log(`  ${f.rule === 'baseline' ? `baseline Δ ${f.delta}` : `gap ${f.gap}px`}  ${f.fixture}: ${f.pair}`)
  if (findings.length) process.exitCode = 1
}

if (import.meta.main) await main()
