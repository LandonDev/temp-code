/**
 * Run from the repo root:
 * bun scripts/ui-preview.ts path/to/component.tsx#Export --props '{"children":"Save"}'
 *
 * Writes /tmp/ui-preview/Export.html and Export.light.html (or under --out <dir>),
 * linked to each other. --shot also writes Export[.light].864.png and .400.png
 * through headless Chrome (TEMP_CODE_CHROME, else Playwright's cached
 * chrome-headless-shell), each page as tall as its content.
 * Separate documents keep html.theme-light and dark: selectors intact, without
 * iframes or CSS rewriting. Both embed out/renderer/assets/*.css when present.
 * Adjacent component.fixtures.tsx carries [{ name, props }] (its default export,
 * else `fixtures`, else its first such array); all fixtures appear in each theme. --props supplies shared defaults, fixtures override them.
 * Use "fn" for required callbacks (also within nested props); it becomes a noop.
 * The component renders with the client renderer into a jsdom document (the
 * stores' useSyncExternalStore reads need no server snapshot that way), then
 * its markup is written into a static page. Events and portals still need a
 * DOM test.
 */
import { plugin } from 'bun'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

const root = resolve(import.meta.dirname, '..')

// Bun reads only the root tsconfig's paths; the renderer's own aliases
// (@renderer, @aliax, @server/shared, @shared) live in tsconfig.web.json, and a
// runtime plugin's onResolve never sees a bare specifier (Bun 1.4). So the
// script runs itself once more under that tsconfig, which resolves them all.
const CHILD = 'UI_PREVIEW_CHILD'
if (import.meta.main && !process.env[CHILD]) {
  const child = spawnSync(process.execPath, ['--tsconfig-override', join(root, 'tsconfig.web.json'), process.argv[1], ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, [CHILD]: '1' }
  })
  process.exit(child.status ?? 1)
}

plugin({
  name: 'ui-preview-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    // A Vite worker import (`monaco…/editor.worker?worker`) is a constructor in
    // the app; a static render never starts one.
    build.onLoad({ filter: /\?worker$/ }, () => ({ contents: 'export default class Worker {}', loader: 'js' }))
  }
})

type Props = Record<string, unknown>
type Fixture = { name: string; props: Props }
const noop = (): void => {}

// Only plain objects and arrays are walked: a fixture's Set, Map or element passes as it is.
function stubCallbacks(value: unknown): unknown {
  if (value === 'fn') return noop
  if (Array.isArray(value)) return value.map(stubCallbacks)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && !('$$typeof' in value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stubCallbacks(item)]))
  }
  return value
}

/** The fixtures a module beside a component carries: its default export, else
 *  `fixtures`, else the first exported array of `{ name, props }`. */
function fixturesOf(module: Record<string, unknown>): unknown {
  if (Array.isArray(module.default)) return module.default
  if (Array.isArray(module.fixtures)) return module.fixtures
  return Object.values(module).find((value) => Array.isArray(value) && value.every((item) => isProps(item) && 'name' in item && 'props' in item))
}

/** One jsdom document for the whole run, its globals installed once: React's
 *  scheduler and the stores keep running between renders, so nothing is torn
 *  down until the child process exits. */
let page: JSDOM | null = null
function documentWindow(): JSDOM['window'] {
  if (page) return page.window
  page = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
  const { window } = page
  const target = globalThis as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'localStorage', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'DOMRect', 'SVGElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLBRElement', 'customElements', 'HTMLDivElement', 'HTMLSpanElement', 'HTMLCanvasElement', 'DocumentFragment', 'Range', 'Selection', 'getSelection', 'self', 'location', 'FocusEvent', 'UIEvent', 'WheelEvent', 'Text']) {
    const value = (window as unknown as Record<string, unknown>)[key]
    if (value !== undefined && target[key] === undefined) target[key] = value
  }
  if (target.ResizeObserver === undefined) target.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  if (target.matchMedia === undefined) target.matchMedia = matchMedia
  window.matchMedia ??= matchMedia as unknown as typeof window.matchMedia
  // jsdom has neither: a tab strip escapes its ids and scrolls its active tab into view.
  if (target.CSS === undefined) target.CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`), supports: () => false }
  window.Element.prototype.scrollIntoView ??= function scrollIntoView() {}
  // Monaco probes the clipboard commands as it loads.
  window.document.queryCommandSupported ??= () => false
  return window
}

/** The component's markup after a client render: one mount into a fresh
 *  container, one flush, the container's innerHTML. */
async function clientMarkup(component: ComponentType<Props>, props: Props): Promise<string> {
  const window = documentWindow()
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(createElement(component, props)))
  // Effects and short animations (a count ticking up, a morph) land after the
  // first render: read the markup until two reads 50ms apart agree, at most
  // 400ms, so a fixture shows what the component settles on.
  await new Promise((done) => setTimeout(done, 0))
  let html = container.innerHTML
  for (let waited = 0; waited < 400; waited += 50) {
    await new Promise((done) => setTimeout(done, 50))
    const next = container.innerHTML
    if (next === html) break
    html = next
  }
  root.unmount()
  container.remove()
  return html
}

function isProps(value: unknown): value is Props {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      props: { type: 'string' },
      width: { type: 'string', default: '480' },
      out: { type: 'string', default: '/tmp/ui-preview' },
      shot: { type: 'boolean', default: false }
    }
  })
  const [target] = positionals
  const match = target?.match(/^(.+)#([^#]+)$/)
  if (positionals.length !== 1 || !match) {
    throw new Error('Usage: bun scripts/ui-preview.ts <module>#<export> [--props \'<json>\'] [--width 480] [--out <dir>] [--shot]')
  }
  const width = Number(values.width)
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error('--width must be a positive integer')
  const props: unknown = JSON.parse(values.props ?? '{}')
  if (!isProps(props)) throw new Error('--props must be a JSON object')

  const modulePath = resolve(match[1])
  const exportName = match[2]
  // Some modules read window or document as they load (Monaco's setup among them).
  documentWindow()
  const component = (await import(pathToFileURL(modulePath).href))[exportName] as ComponentType<Props>
  if (!component) throw new Error(`No export "${exportName}" in ${match[1]}`)
  const fixturesPath = join(dirname(modulePath), `${basename(modulePath, extname(modulePath))}.fixtures.tsx`)
  const fixtures: unknown = existsSync(fixturesPath)
    ? fixturesOf(await import(pathToFileURL(fixturesPath).href))
    : [{ name: exportName, props: {} }]
  if (!Array.isArray(fixtures) || !fixtures.every((item): item is Fixture =>
    isProps(item) && typeof item.name === 'string' && isProps(item.props))) {
    throw new Error(`${fixturesPath} must default-export [{ name, props }]`)
  }

  const assets = resolve('out/renderer/assets')
  const cssFiles = existsSync(assets) ? (await readdir(assets)).filter((file) => file.endsWith('.css')).sort() : []
  const css = (await Promise.all(cssFiles.map((file) => readFile(join(assets, file), 'utf8')))).join('\n')
  if (!cssFiles.length) console.log('No built stylesheet at out/renderer/assets/*.css; writing previews without it.')

  const markup = new Map<string, string>()
  for (const fixture of fixtures) markup.set(fixture.name, await clientMarkup(component, stubCallbacks({ ...props, ...fixture.props }) as Props))

  const name = (exportName === 'default' ? basename(modulePath, extname(modulePath)) : exportName)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
  const output = resolve(values.out)
  await mkdir(output, { recursive: true })
  const chrome = values.shot ? chromePath() : null
  if (values.shot && !chrome) throw new Error('--shot needs headless Chrome: set TEMP_CODE_CHROME or install Playwright\'s chrome-headless-shell')
  for (const light of [false, true]) {
    const filename = `${name}${light ? '.light' : ''}.html`
    const other = `${name}${light ? '' : '.light'}.html`
    const page = createElement('html', { lang: 'en', className: light ? 'theme-light' : undefined },
      createElement('head', null,
        createElement('meta', { charSet: 'utf-8' }),
        createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        createElement('title', null, `${exportName}: ${light ? 'light' : 'dark'} theme`),
        createElement('base', { href: pathToFileURL(`${assets}/`).href }),
        createElement('style', { dangerouslySetInnerHTML: { __html: css } }),
        createElement('style', null, `
          html, body { position: static; inset: auto; width: auto; height: auto; overflow: visible; }
          html { color-scheme: ${light ? 'light' : 'dark'}; }
          body { margin: 0; padding: 24px; background: var(--background, Canvas); color: var(--foreground, CanvasText); font: 13px var(--font-sans, system-ui); }
          main { width: ${width}px; }
          .preview-themes { display: flex; gap: 8px; margin-bottom: 24px; font-size: 12px; }
          .preview-themes a { color: var(--muted-foreground, GrayText); }
          .preview-shot main { width: auto; }
          .preview-fixture + .preview-fixture { margin-top: 24px; }
          .preview-label { margin-bottom: 8px; color: var(--muted-foreground, GrayText); font-size: 11px; }
        `)),
      createElement('body', null,
        createElement('main', null,
          createElement('nav', { className: 'preview-themes', 'aria-label': 'Theme' },
            createElement('h1', { className: 'preview-theme', style: { font: 'inherit', margin: 0 } }, `${light ? 'Light' : 'Dark'} theme`),
            createElement('a', { href: pathToFileURL(join(output, other)).href }, `Open the ${light ? 'dark' : 'light'} theme`)),
          ...fixtures.map((fixture) => createElement('section', { className: 'preview-fixture', key: fixture.name },
            createElement('div', { className: 'preview-label' }, fixture.name),
            createElement('div', { dangerouslySetInnerHTML: { __html: markup.get(fixture.name) ?? '' } }))))))
    const path = join(output, filename)
    const html = `<!doctype html>${renderToStaticMarkup(page)}\n`
    await writeFile(path, html)
    console.log(path)
    if (chrome) for (const shot of await screenshots(chrome, html, join(output, `${name}${light ? '.light' : ''}`))) console.log(shot)
  }
}

const SHOT_WIDTHS = [864, 400]
const MAX_SHOT_HEIGHT = 16_000

/** TEMP_CODE_CHROME, else the newest chrome-headless-shell Playwright cached. */
export function chromePath(env: NodeJS.ProcessEnv = process.env, cache = join(homedir(), '.cache/ms-playwright')): string | null {
  if (env.TEMP_CODE_CHROME) return existsSync(env.TEMP_CODE_CHROME) ? env.TEMP_CODE_CHROME : null
  if (!existsSync(cache)) return null
  const builds = readdirSync(cache).filter((dir) => dir.startsWith('chromium_headless_shell-')).sort().reverse()
  for (const build of builds) {
    const binary = join(cache, build, 'chrome-headless-shell-linux64/chrome-headless-shell')
    if (existsSync(binary)) return binary
  }
  return null
}

/** One PNG per width, each as tall as the page's content: a first load with a
 *  script that writes the content height into the DOM it dumps, then the shot. */
async function screenshots(chrome: string, html: string, stem: string): Promise<string[]> {
  const shotPage = html.replace('<body>', '<body class="preview-shot">')
  const pagePath = `${stem}.shot.html`
  const measurePath = `${stem}.measure.html`
  await writeFile(pagePath, shotPage)
  await writeFile(measurePath, shotPage.replace('</body>', '<script>document.body.dataset.height = String(Math.ceil(document.documentElement.scrollHeight))</script></body>'))
  const flags = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars']
  const shots: string[] = []
  for (const width of SHOT_WIDTHS) {
    const dump = spawnSync(chrome, [...flags, '--dump-dom', '--virtual-time-budget=2000', `--window-size=${width},800`, pathToFileURL(measurePath).href], { encoding: 'utf8', timeout: 60_000 })
    const height = Math.min(MAX_SHOT_HEIGHT, Number(dump.stdout.match(/data-height="(\d+)"/)?.[1] ?? 800))
    const png = `${stem}.${width}.png`
    const shot = spawnSync(chrome, [...flags, `--screenshot=${png}`, `--window-size=${width},${height}`, pathToFileURL(pagePath).href], { encoding: 'utf8', timeout: 60_000 })
    if (shot.status !== 0 || !existsSync(png)) throw new Error(`Chrome could not shoot ${png}: ${shot.stderr.trim().split('\n').at(-1) ?? ''}`)
    shots.push(png)
  }
  await rm(measurePath, { force: true })
  return shots
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
