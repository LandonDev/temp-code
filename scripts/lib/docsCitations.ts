/**
 * What a CLAUDE.md section cites: the `script:` entries and `bun run` names
 * (each must be a key of package.json's `scripts`) and the repository paths
 * under src/, scripts/, native/, docs/, ios/ and infra/ (each must exist).
 * scripts/docsGuard.test.ts runs it over the sections the docs sweep wrote.
 */

/** The text of the `## <heading>` section, up to the next `## `, or null. */
export function sectionOf(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

const ROOTS = ['src', 'scripts', 'native', 'docs', 'ios', 'infra']
const PATH = new RegExp(`(?<![\\w./@~-])((?:${ROOTS.join('|')})/(?:[^\\s\`'"(),;|{]|\\{[^}\\s]*\\})*)`, 'g')
const SCRIPT = /\bscript:([a-z0-9][a-z0-9:-]*[a-z0-9])/g
const BUN_RUN = /\bbun run ([a-z][^\s`'"),;]*)/g

/** `a/{b,c}.ts` as `a/b.ts` and `a/c.ts`, one level. */
export function expandBraces(token: string): string[] {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(token)
  return m ? m[2].split(',').map((part) => `${m[1]}${part}${m[3]}`) : [token]
}

export interface Citations {
  scripts: string[]
  paths: string[]
}

/** Every script name and path the text cites, each once, in order of first mention. */
export function citations(text: string): Citations {
  const scripts = new Set<string>()
  for (const m of text.matchAll(SCRIPT)) scripts.add(`script:${m[1]}`)
  for (const m of text.matchAll(BUN_RUN)) {
    const name = m[1].replace(/[.:]+$/, '')
    // `bun run scripts/x.ts` runs a file: the path rule checks it.
    if (!name.includes('/') && !/\.(ts|mjs|js|sh)$/.test(name)) scripts.add(name)
  }
  const paths = new Set<string>()
  for (const m of text.matchAll(PATH)) {
    const token = m[1].split('#')[0].replace(/[.:]+$/, '')
    if (token.includes('*') || token.includes('<')) continue
    for (const path of expandBraces(token)) paths.add(path.replace(/[.:]+$/, ''))
  }
  return { scripts: [...scripts], paths: [...paths] }
}
