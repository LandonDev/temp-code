// An approval as one line, read by the notifier's notices
// (remote/notifier.ts) and the host's away rows (sessions.ts interceptAway).

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`
const DETAIL_CHARS = 90

const basename = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/**
 * An approval as the question the person answers: "Run bun test?",
 * "Read types.ts?", "Use linear?". The harness's own title when it gives
 * one ("Claude wants to read foo.txt" → "Read foo.txt?", OpenCode's "Run
 * rm -rf build" → "Run rm -rf build?", a Pi extension's own question
 * as asked), else a verb by tool name; the detail is cut at 90 characters.
 */
export function approvalLine(toolName: string, input: unknown, title?: string): string {
  // The harness's own words: "<who> wants to <action>" gives the action, any other title is the question itself.
  const sentence = oneLine(title ?? '')
  const action = (/\bwants to\s+(.+)$/i.exec(sentence)?.[1] ?? sentence).replace(/`/g, '').replace(/[.\s]+$/, '')
  if (action) {
    const line = cut(action[0].toUpperCase() + action.slice(1), DETAIL_CHARS + 10)
    return line.includes('?') ? line : `${line}?`
  }
  const rec = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const str = (...keys: string[]): string | null => {
    for (const key of keys) {
      const v = rec[key]
      if (typeof v === 'string' && v.trim()) return oneLine(v)
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return oneLine(v.join(' '))
    }
    return null
  }
  const firstKey = (key: string): string | null => {
    const v = rec[key]
    return v && typeof v === 'object' && !Array.isArray(v) ? (Object.keys(v)[0] ?? null) : null
  }
  const line = (verb: string, detail: string | null, none: string): string =>
    detail ? `${verb} ${cut(detail, DETAIL_CHARS)}?` : `${none}?`
  const name = toolName.trim()
  const lower = name.toLowerCase()
  const path = str('file_path', 'notebook_path', 'path') ?? firstKey('fileChanges') ?? firstKey('changes')
  switch (lower) {
    case 'bash':
    case 'shell':
    case 'exec_command':
    case 'local_shell':
      return line('Run', str('command', 'cmd'), 'Run a command')
    case 'read':
      return line('Read', path && basename(path), 'Read a file')
    case 'write':
      return line('Create', path && basename(path), 'Create a file')
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
    case 'apply_patch':
      return line('Edit', path && basename(path), 'Edit files')
    case 'webfetch': {
      const url = str('url')
      let host: string | null = null
      try {
        host = url ? new URL(url).hostname : null
      } catch {
        host = url
      }
      return line('Fetch', host, 'Fetch a page')
    }
    case 'websearch':
      return line('Search the web for', str('query'), 'Search the web')
  }
  if (lower.startsWith('mcp__')) {
    const end = name.lastIndexOf('__')
    const server = end > 5 ? name.slice(5, end) : name.slice(5)
    return line('Use', server || null, 'Use a tool')
  }
  const mcp = /^MCP server "(.*)"$/.exec(name)
  if (mcp) return line('Use', mcp[1] || null, 'Use a tool')
  return line('Use', name || null, 'Use a tool')
}
