/**
 * The one-off that turned CLAUDE.md into an index (2026-11-11): every `## `
 * section but the hard rules moves, word for word, into
 * `docs/agents/<slug>.md`, headed by its own heading. Deterministic: the
 * same CLAUDE.md gives the same files. CLAUDE.md itself is written by hand
 * afterwards (one entry per moved file); scripts/claudeMdBudget.test.ts
 * holds it to 40,000 bytes and every link to a file.
 *
 * Why: the project CLAUDE.md had grown to 305 KB, about 121k tokens of every
 * Claude thread's first request on a 200k window, and every thread in the
 * project compacted on every request (docs/agents/prompt-overhead.md).
 *
 * Run: bun scripts/split-claude-md.ts [--from <CLAUDE.md>] [--out docs/agents]
 * Prints the moved headings with their files and the ones kept inline.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** The sections that stay in CLAUDE.md as they are: the rules every thread needs before it touches anything. */
export const INLINE = new Set([
  'One line: prod runs the newest published GitHub release',
  'The user lives in the installed app — never touch it',
  'Testing: spawn an isolated dev instance',
  'The user dogfoods master on the prod data',
  'The prod worktree is retired'
])

/** A file name per heading where the words before its colon would collide or read badly. */
const SLUGS: Record<string, string> = {
  'Releases: the local train tags, `release:publish` ships': 'releases',
  'UI standard: Kobra on Base UI, docs/DESIGN.md wins': 'ui-standard',
  'Launch-time code caches: boot.js, the compile cache, the app scheme': 'launch-code-caches',
  'Launch: the rail paints from the launch mirror': 'launch-mirror',
  'Plans: `plan_complete` and the auto-start': 'plans-auto-start',
  'Plans: one build per plan, and the project plan': 'plans-project-plan',
  'The Linux agent host: headless mode on the box': 'linux-agent-host',
  'The iOS contract package is generated': 'ios-contract',
  'The iOS client: ios/TempCodeClient and ios/TempCode': 'ios-client',
  'The desktop transcript: a viewport window, markdown in a worker': 'desktop-transcript',
  'The renderer over time: React 19.3.1, the soak, a push re-renders only what it changed': 'renderer-over-time',
  'The shape that scales: many threads exist, a bounded number run': 'shape-that-scales',
  'Chats outside every workspace stay there': 'chats-outside-workspaces'
}

/** `## Provider traffic: the gateway, …` → `provider-traffic`. */
export function slugOf(heading: string): string {
  if (SLUGS[heading]) return SLUGS[heading]
  const lead = heading.split(':')[0]
  return lead
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/^the /, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface Section {
  heading: string
  body: string
}

/** The text before the first `## ` heading, and each section with its body verbatim (fenced blocks respected). */
export function sectionsOf(text: string): { head: string; sections: Section[] } {
  const lines = text.split('\n')
  const sections: Section[] = []
  const head: string[] = []
  let current: { heading: string; lines: string[] } | null = null
  let fenced = false
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced
    if (!fenced && line.startsWith('## ')) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').replace(/\n+$/, '\n') })
      current = { heading: line.slice(3).trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else head.push(line)
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join('\n').replace(/\n+$/, '\n') })
  return { head: head.join('\n'), sections }
}

/** One moved section as its own file: its heading as the title, the body as it was. */
export function fileOf(section: Section): string {
  return `# ${section.heading}\n${section.body.startsWith('\n') ? '' : '\n'}${section.body}`
}

if (import.meta.main) {
  const from = resolve(arg('from') ?? 'CLAUDE.md')
  const out = resolve(arg('out') ?? join('docs', 'agents'))
  const { sections } = sectionsOf(readFileSync(from, 'utf8'))
  mkdirSync(out, { recursive: true })
  const seen = new Map<string, string>()
  for (const section of sections) {
    if (INLINE.has(section.heading)) {
      console.log(`inline  ${section.heading}`)
      continue
    }
    const slug = slugOf(section.heading)
    if (seen.has(slug)) throw new Error(`two sections slug to ${slug}: "${seen.get(slug)}" and "${section.heading}"`)
    seen.set(slug, section.heading)
    writeFileSync(join(out, `${slug}.md`), fileOf(section))
    console.log(`moved   ${section.heading} → ${slug}.md (${Buffer.byteLength(section.body)} bytes)`)
  }
}
