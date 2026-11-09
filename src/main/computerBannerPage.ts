/** Mirrored from index.css; computerBannerPage.test.ts holds these equal. */
export const BANNER_TOKENS = {
  dark: {
    popover: 'oklch(0.24 0.004 270)',
    border: 'rgb(255 255 255 / 0.09)',
    foreground: 'oklch(0.93 0.003 270)',
    'muted-foreground': 'oklch(0.68 0.006 270)',
    muted: 'oklch(0.275 0.004 270)'
  },
  light: {
    popover: 'oklch(1 0 0)',
    border: 'rgb(0 0 0 / 0.08)',
    foreground: 'oklch(0.2 0.004 270)',
    'muted-foreground': 'oklch(0.5 0.008 270)',
    muted: 'oklch(0.955 0.002 80)'
  },
  shared: {
    'dur-base': '180ms',
    'dur-fast': '120ms',
    'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    'ease-exit': 'cubic-bezier(0.4, 0, 0.6, 1)',
    'font-sans':
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
    'font-mono':
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  },
  type: { body: '13px', key: '11px' }
} as const
const vars = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([k, v]) => `--${k}: ${v};`)
    .join(' ')

/** A passive page: only the main process changes its classes. */
export function computerBannerPage(): string {
  return `<!doctype html><html lang="en" class="hidden"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'">
<title>Computer use</title><style>
:root { ${vars(BANNER_TOKENS.dark)} ${vars(BANNER_TOKENS.shared)} ${vars(BANNER_TOKENS.type)} }
html.theme-light { ${vars(BANNER_TOKENS.light)} }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; overflow: hidden; }
body { width: max-content; color: var(--foreground); font: var(--body)/20px var(--font-sans); -webkit-font-smoothing: antialiased; user-select: none; }
#pill { display: flex; align-items: center; height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9999px; background: var(--popover); white-space: nowrap; opacity: 1; transition: opacity var(--dur-base) var(--ease-out); }
html.hidden #pill { opacity: 0; transition: opacity var(--dur-fast) var(--ease-exit); }
@starting-style { #pill { opacity: 0; } }
#escape { display: none; align-items: center; gap: 8px; margin-left: 8px; }
html.esc #escape { display: inline-flex; }
kbd { display: inline-flex; align-items: center; justify-content: center; height: 20px; padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; background: var(--muted); color: var(--foreground); font: 500 var(--key)/1 var(--font-sans); }
#stop { color: var(--muted-foreground); }
@media (prefers-reduced-motion: reduce) { #pill { transition-duration: var(--dur-fast); } }
</style></head><body><div id="pill"><span>TempCode is using your Mac</span><span id="escape"><kbd>Esc</kbd><span id="stop">to stop</span></span></div></body></html>`
}
