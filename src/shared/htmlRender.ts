import { ASSET_SCHEME } from './assets'

/**
 * Agent-authored HTML pages ("HTML renders", ported from T3 Code) are
 * self-contained documents an agent publishes into a thread with the
 * `html_render` app tool. Main stores each one under
 * `<userData>/html-renders/<sessionId>/<pageId>.html` with a small bootstrap
 * injected into its head; the renderer shows it in a sandboxed iframe and
 * hands it the active theme as CSS custom properties.
 */

export const HTML_RENDER_TOOL_NAME = 'html_render'
export const HTML_PREVIEW_TOOL_NAME = 'html_preview'
export const HTML_RENDER_MIN_HEIGHT = 80
export const HTML_RENDER_MAX_HEIGHT = 2000
export const HTML_RENDER_MAX_TITLE_LENGTH = 200

/** What the `html_render` tool result carries so the renderer can show the page. */
export interface HtmlRenderReference {
  readonly sessionId: string
  readonly pageId: string
  readonly title: string
  /** The agent's frame height in CSS pixels, and the cap on any measured height. */
  readonly height: number
  /**
   * `[width, contentHeight]` pairs main measured at publish, ascending by
   * width. Absent when measuring failed or timed out.
   */
  readonly heights?: ReadonlyArray<readonly [width: number, height: number]>
}

/**
 * The transcript column is `max-w-4xl` (896px) with 16px of padding each
 * side, so a page at full width gets 864px. Narrower windows shrink it.
 */
export const HTML_RENDER_COLUMN_WIDTH = 864

/** Frame widths main measures a page at, from a narrow window to the full column. */
export const HTML_RENDER_MEASURE_WIDTHS = [320, 400, 480, 560, 640, 728, 800, 864] as const

const MAX_MEASURED_HEIGHTS = 24
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function readMeasuredHeights(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === 'number' &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampHtmlRenderHeight(entry[1])] as const]
      : []
  )
  return heights.length === value.length
    ? [...heights].sort((left, right) => left[0] - right[0])
    : undefined
}

export function readHtmlRenderReference(value: unknown): HtmlRenderReference | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { sessionId, pageId, title, height, heights } = value as Record<string, unknown>
  if (
    typeof sessionId !== 'string' ||
    !ID_PATTERN.test(sessionId) ||
    typeof pageId !== 'string' ||
    !ID_PATTERN.test(pageId) ||
    typeof title !== 'string' ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
  ) {
    return undefined
  }
  const measured = readMeasuredHeights(heights)
  return {
    sessionId,
    pageId,
    title: title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || 'HTML',
    height: clampHtmlRenderHeight(height),
    ...(measured === undefined ? {} : { heights: measured })
  }
}

/** Whether two references show the same page at the same sizes. */
export function htmlRenderReferencesEqual(left: HtmlRenderReference, right: HtmlRenderReference) {
  return (
    left.sessionId === right.sessionId &&
    left.pageId === right.pageId &&
    left.title === right.title &&
    left.height === right.height &&
    (left.heights ?? []).length === (right.heights ?? []).length &&
    (left.heights ?? []).every(
      ([width, height], index) =>
        right.heights?.[index]?.[0] === width && right.heights[index][1] === height
    )
  )
}

// The taller of the heights measured at the nearest widths on each side. A
// breakpoint between two measured widths can make the page as tall as either.
export function measuredHeight(
  heights: NonNullable<HtmlRenderReference['heights']>,
  width: number
) {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width)
  const high = above === -1 ? heights.length - 1 : above
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1)
  return Math.max(heights[low]![1], heights[high]![1])
}

/**
 * The frame height for a page at a frame width. It is the page's own reported
 * `contentHeight` when the renderer has one, else main's measurement for
 * that width. A page even a few pixels taller than its frame scrolls inside it
 * and takes the reader's scroll, so the frame fits the page. The agent's height
 * caps it only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  reference: HtmlRenderReference,
  width: number,
  contentHeight?: number
) {
  const heights = reference.heights
  if (heights === undefined || heights.length === 0) {
    return clampHtmlRenderHeight(Math.min(reference.height, contentHeight ?? reference.height))
  }
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > reference.height
      ? reference.height
      : HTML_RENDER_MAX_HEIGHT
  return clampHtmlRenderHeight(Math.min(cap, contentHeight ?? measuredHeight(heights, width)))
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string) {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()
  return `${name || 'Page'}.html`
}

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)))
}

/** The stored page's URL under the app's asset protocol. */
export function htmlRenderPageUrl(reference: Pick<HtmlRenderReference, 'sessionId' | 'pageId'>) {
  return `${ASSET_SCHEME}://page/${reference.sessionId}/${reference.pageId}.html`
}

// ── theme ────────────────────────────────────────────────────────────

export type HtmlRenderAppearance = 'dark' | 'light'

/** The app's own tokens, as resolved colours, that a page is themed from. */
export interface HtmlRenderTokens {
  readonly background: string
  readonly foreground: string
  readonly accent: string
  readonly link: string
  readonly success: string
  readonly warning: string
  readonly danger: string
  readonly info: string
  readonly violet: string
  readonly cyan: string
  readonly busy: string
  readonly fontSans: string
  readonly fontMono: string
}

const FONT_SANS =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'
const FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

/** index.css's values with the hue/lightness variables resolved by hand. */
export const DEFAULT_TOKENS: Readonly<Record<HtmlRenderAppearance, HtmlRenderTokens>> = {
  dark: {
    background: 'hsl(240 0% 9%)',
    foreground: 'hsl(240 0% 92%)',
    accent: 'hsl(211 92% 62%)',
    link: '#7dd3fc',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#f87171',
    info: '#60a5fa',
    violet: '#a78bfa',
    cyan: '#22d3ee',
    busy: '#f472b6',
    fontSans: FONT_SANS,
    fontMono: FONT_MONO
  },
  light: {
    background: 'hsl(240 0% 97%)',
    foreground: 'hsl(240 0% 18%)',
    accent: 'hsl(211 92% 62%)',
    link: 'hsl(211 92% 40%)',
    success: '#059669',
    warning: '#d97706',
    danger: '#dc2626',
    info: '#2563eb',
    violet: '#7c3aed',
    cyan: '#0891b2',
    busy: '#db2777',
    fontSans: FONT_SANS,
    fontMono: FONT_MONO
  }
}

/** The resolved theme the renderer hands an HTML render. */
export interface HtmlRenderTheme {
  readonly appearance: HtmlRenderAppearance
  readonly variables: Readonly<Record<string, string>>
}

const mix = (colour: string, percent: number, over = 'transparent') =>
  `color-mix(in srgb, ${colour} ${percent}%, ${over})`

/**
 * Maps the app's tokens to the variables HTML renders style against. The
 * names are the ones T3 documents, so agents' habits transfer.
 */
export function htmlRenderTheme(
  tokens: HtmlRenderTokens,
  appearance: HtmlRenderAppearance
): HtmlRenderTheme {
  const fg = tokens.foreground
  const bg = tokens.background
  return {
    appearance,
    variables: {
      '--background': bg,
      '--foreground': fg,
      '--muted': mix(fg, 6),
      '--muted-foreground': mix(fg, 55),
      '--card': mix(fg, 4, bg),
      '--card-foreground': fg,
      '--border': mix(fg, 10),
      '--input': mix(fg, 10),
      '--ring': tokens.accent,
      '--primary': fg,
      '--primary-foreground': bg,
      '--accent': tokens.accent,
      '--accent-foreground': '#fff',
      '--link': tokens.link,
      '--destructive': tokens.danger,
      '--warning': tokens.warning,
      '--success': tokens.success,
      '--info': tokens.info,
      '--code-background': mix(fg, 6),
      '--chart-1': tokens.accent,
      '--chart-2': tokens.cyan,
      '--chart-3': tokens.violet,
      '--chart-4': tokens.warning,
      '--chart-5': tokens.success,
      '--chart-6': tokens.busy,
      '--radius': '10px',
      '--font-sans': tokens.fontSans,
      '--font-mono': tokens.fontMono
    }
  }
}

/** Every variable `htmlRenderTheme` sets, for the guide and the tests. */
export const HTML_RENDER_THEME_VARIABLES = Object.keys(
  htmlRenderTheme(DEFAULT_TOKENS.dark, 'dark').variables
)

/** Agent-facing reference for the injected variables, used in tool descriptions. */
export const HTML_RENDER_THEME_GUIDE = [
  "temp-code injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  '--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,',
  '--card, --card-foreground, --border, --input, --ring, --primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --link,',
  '--destructive, --warning, --success, --info, --code-background,',
  '--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.',
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it."
].join(' ')

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px at full width, about 320px when the window is narrow), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  'Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.',
  'If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.',
  'Give charts fixed pixel heights rather than heights that scale with width.',
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again."
].join(' ')

export const HTML_PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.'

// ── MCP Apps messages ────────────────────────────────────────────────

// The bridge between a render and its frame speaks the MCP Apps protocol
// (JSON-RPC over postMessage): https://github.com/modelcontextprotocol/ext-apps
const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed'
const OPEN_LINK_METHOD = 'ui/open-link'
const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed'

/** The content height in a framed render's `ui/notifications/size-changed` notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { jsonrpc, method, params } = data as Record<string, unknown>
  if (jsonrpc !== '2.0' || method !== SIZE_CHANGED_METHOD) return undefined
  const height =
    typeof params === 'object' && params !== null
      ? (params as { height?: unknown }).height
      : undefined
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : undefined
}

/** A render's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readHtmlRenderLinkRequest(
  data: unknown
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { jsonrpc, id, method, params } = data as Record<string, unknown>
  if (jsonrpc !== '2.0' || method !== OPEN_LINK_METHOD) return undefined
  if (typeof id !== 'string' && typeof id !== 'number') return undefined
  const url =
    typeof params === 'object' && params !== null ? (params as { url?: unknown }).url : undefined
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? { id, url } : undefined
}

/** The empty result the frame sends back for a render's request. */
export function htmlRenderResult(id: string | number) {
  return { jsonrpc: '2.0', id, result: {} } as const
}

const THEME_FRAGMENT_KEY = 'tc-theme'

/** URL fragment that hands a render its theme before first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`
}

/** The `host-context-changed` notification the frame posts into a mounted render when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: '2.0',
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } }
  } as const
}

// ── bootstrap ────────────────────────────────────────────────────────

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the thread, so it stays hidden.
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}' +
  'html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}'

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join('')
  return `:root{color-scheme:${theme.appearance};${declarations}}`
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks to another page never replaces the page inside the thread:
// a framed page asks its frame to open it, and a top-level page opens it as
// a new window. A framed page also reports its content height, measured as
// main measures it, so its frame can fit the page.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("tc-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"tc-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`

function bootstrapMarkup(markup: string): string {
  const dark = htmlRenderTheme(DEFAULT_TOKENS.dark, 'dark')
  const light = htmlRenderTheme(DEFAULT_TOKENS.light, 'light')
  // Without a frame-provided theme (a saved copy opened in a browser, the
  // preview window without a fragment) the page follows the OS appearance.
  const defaultCss = `${rootRule(dark)}@media (prefers-color-scheme: light){${rootRule(light)}}${BASE_CSS}`
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ''
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="tc-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`
  ].join('')
}

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length)
  )
  const parts: string[] = []
  let depth = 0
  let start = 0
  let at = 0
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length
      parts.push(scan.slice(at, start), ' '.repeat(end - start))
      at = end
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start))
    at = scan.length
  }
  parts.push(scan.slice(at))
  return parts.join('')
}

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html)
  const markup = bootstrapMarkup(scan)
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + markup + html.slice(at)
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${markup}</head>${html}`
}

// ── tool descriptions (shared with scripts/app-mcp-bridge.mjs by copy; a test keeps them equal) ──

export const HTML_PREVIEW_TOOL_DESCRIPTION = `Render an HTML page in temp-code's hidden browser window and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, warning, error, and uncaught exceptions, with locations pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render. ${HTML_PAGE_RULES} The page gets the theme variables and layout described in html_render.`

export const HTML_RENDER_TOOL_DESCRIPTION = `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. Preview with html_preview first. temp-code fits the frame to the page's height at each reader's width. A height below the page's contentHeight caps the frame there, and the rest scrolls inside it. ${HTML_PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`

export const HTML_TOOL_PARAMS = {
  html: 'A complete, self-contained HTML document.',
  width: `Viewport width in CSS pixels, 240-1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column at full width; use about 400 to check a narrow window.`,
  appearance: 'Theme to preview. Defaults to dark.',
  title: 'Short name for the page.',
  height: `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`
} as const

/** What `html_render` tells the agent after the page is up. */
export const HTML_RENDER_SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say."
