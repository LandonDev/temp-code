/**
 * Service identity for tool calls that are REALLY a known product's API —
 * so a claude MCP call or a raw GraphQL curl wears the same face (logo +
 * humanized action) a codex connector call gets from appContext.
 *
 * Two detectors:
 *  - MCP names: mcp__linear__search_issues → { app: 'linear', action:
 *    'Search issues' } — the brand mark resolves from the server name.
 *  - Commands/URLs: a Bash/shell command or WebFetch that talks to a
 *    known API host → { app } (the action stays with the summarizer's
 *    caption, which already reads well).
 */

export interface ToolDisplay {
  app?: string
  action?: string
}

/** API hosts → the addon-brand key whose logo the row should wear. */
const HOSTS: [RegExp, string][] = [
  [/api\.linear\.app|mcp\.linear\.app/, 'linear'],
  [/api\.github\.com|uploads\.github\.com/, 'github'],
  [/slack\.com\/api|hooks\.slack\.com/, 'slack'],
  [/api\.notion\.com/, 'notion'],
  [/sentry\.io\/api/, 'sentry'],
  [/api\.vercel\.com/, 'vercel'],
  [/api\.stripe\.com/, 'stripe'],
  [/api\.figma\.com/, 'figma'],
  [/\.supabase\.co/, 'supabase'],
  [/api\.trello\.com/, 'trello'],
  [/api\.cloudflare\.com/, 'cloudflare'],
  [/\.atlassian\.net/, 'jira'],
  [/discord(?:app)?\.com\/api/, 'discord'],
  [/\.convex\.(?:cloud|site)/, 'convex'],
  [/api\.webflow\.com/, 'webflow'],
  [/api\.clerk\.(?:com|dev)/, 'clerk']
]

const hostApp = (text: string): string | undefined =>
  HOSTS.find(([re]) => re.test(text))?.[1]

/** "search_issues" / "searchIssues" / "search-issues" → "Search issues". */
function humanizeAction(tool: string): string {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (words.length === 0) return tool
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}

/** Identity for a tool call, when it clearly belongs to a known service.
 *  Returns undefined for plain tools — their existing faces stay. */
export function toolDisplay(name: string, input: unknown): ToolDisplay | undefined {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) {
    // In-app toolsets (orchestrator/app) are mechanics, not services.
    if (mcp[1] === 'app' || mcp[1] === 'orchestrator') return undefined
    return { app: mcp[1], action: humanizeAction(mcp[2]) }
  }
  const i = (input ?? {}) as Record<string, unknown>
  const text =
    typeof i.command === 'string' ? i.command : typeof i.url === 'string' ? i.url : null
  if ((name === 'Bash' || name === 'WebFetch') && text) {
    const app = hostApp(text)
    if (app) return { app }
  }
  return undefined
}
