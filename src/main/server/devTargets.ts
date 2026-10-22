import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DevTarget } from '@shared/contract-devservers'

/**
 * What a project can serve (docs/box.md "Dev servers on the box"): the dev
 * scripts of its package.json and of its workspaces (package.json
 * `workspaces`, pnpm-workspace.yaml, else apps/* and packages/*), each run
 * with the package manager its lockfile names, and its Xcode apps (an
 * .xcworkspace, an .xcodeproj or an XcodeGen project.yml at the root or one
 * folder down, outside an Expo app). An Electron app's script is left out:
 * it is not a server, and the box has no screen for it.
 */

export interface DevTargetFs {
  read: (path: string) => Promise<string | null>
  /** Entry names of a dir ([] when it is not one). */
  list: (path: string) => Promise<string[]>
  isDir: (path: string) => Promise<boolean>
}

export const nodeFs: DevTargetFs = {
  read: (p) => readFile(p, 'utf8').catch(() => null),
  list: (p) => readdir(p).catch(() => []),
  isDir: (p) =>
    stat(p).then(
      (s) => s.isDirectory(),
      () => false
    )
}

/** Script names that serve something. */
const DEV_SCRIPT = /^(?:dev|start|serve|preview|web|storybook)(?::[\w.-]+)?$/
const NOT_A_SERVER = /\b(?:electron(?:-vite|-forge|-builder)?|tsc|vitest|jest|eslint|prettier)\b/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.expo', 'Pods', 'DerivedData', '.temp-code', '.claude'])
const MAX_PACKAGES = 40

interface Pkg {
  name?: string
  scripts?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const FRAMEWORKS: [RegExp, string][] = [
  [/\bexpo\b/, 'expo'],
  [/\bnext\b/, 'next'],
  [/\bnuxt\b/, 'nuxt'],
  [/\bastro\b/, 'astro'],
  [/\bremix\b/, 'remix'],
  [/\bsvelte-kit\b|\bsveltekit\b/, 'sveltekit'],
  [/\bstorybook\b/, 'storybook'],
  [/\bvite\b/, 'vite'],
  [/\bwebpack(?:-dev-server)?\b/, 'webpack'],
  [/\breact-scripts\b/, 'react-scripts'],
  [/\bwrangler\b/, 'wrangler'],
  [/\bconvex\b/, 'convex'],
  [/\bbun\b/, 'bun'],
  [/\bnodemon\b|\bnode\b|\btsx\b/, 'node']
]

export function frameworkOf(command: string): string | null {
  for (const [re, name] of FRAMEWORKS) if (re.test(command)) return name
  return null
}

/** The package manager the lockfile at the root names, and how it runs a script. */
export function runnerOf(rootEntries: readonly string[]): (script: string) => string {
  const has = (n: string) => rootEntries.includes(n)
  if (has('bun.lock') || has('bun.lockb')) return (s) => `bun run ${s}`
  if (has('pnpm-lock.yaml')) return (s) => `pnpm run ${s}`
  if (has('yarn.lock')) return (s) => `yarn ${s}`
  return (s) => `npm run ${s}`
}

const parseJson = (text: string | null): Pkg | null => {
  if (!text) return null
  try {
    return JSON.parse(text) as Pkg
  } catch {
    return null
  }
}

/** pnpm-workspace.yaml's `packages:` list, read line by line (no YAML parser for one list). */
export function pnpmPackages(text: string | null): string[] {
  if (!text) return []
  const out: string[] = []
  let inList = false
  for (const line of text.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inList = true
      continue
    }
    if (inList) {
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)
      if (m) out.push(m[1].trim())
      else if (/^\S/.test(line)) inList = false
    }
  }
  return out
}

/** Expand `dir/*` and plain dirs (deeper globs are read as their first level); negations dropped. */
async function expand(cwd: string, patterns: readonly string[], fs: DevTargetFs): Promise<string[]> {
  const out = new Set<string>()
  for (const raw of patterns) {
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '')
    if (!p || p.startsWith('!')) continue
    const star = p.indexOf('*')
    if (star < 0) {
      if (await fs.isDir(join(cwd, p))) out.add(p)
      continue
    }
    const base = p.slice(0, star).replace(/\/$/, '')
    for (const entry of await fs.list(join(cwd, base))) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      const dir = base ? `${base}/${entry}` : entry
      if (await fs.isDir(join(cwd, dir))) out.add(dir)
    }
  }
  return [...out].sort()
}

const usesExpo = (pkg: Pkg | null): boolean => !!(pkg?.dependencies?.expo ?? pkg?.devDependencies?.expo)

function scriptTargets(dir: string, pkg: Pkg, name: string, run: (s: string) => string): DevTarget[] {
  const out: DevTarget[] = []
  for (const [script, body] of Object.entries(pkg.scripts ?? {})) {
    if (!DEV_SCRIPT.test(script) || NOT_A_SERVER.test(body)) continue
    const framework = frameworkOf(body)
    out.push({
      id: `${dir || '.'}#${script}`,
      name,
      script,
      kind: framework === 'expo' ? 'expo' : 'web',
      framework,
      dir,
      command: run(script),
      macOnly: false
    })
  }
  // dev first, then the rest as package.json lists them.
  return out.sort((a, b) => Number(b.script === 'dev') - Number(a.script === 'dev'))
}

/** An iOS target: build for the simulator, install on the booted one (booting one when none is), launch with its console. */
export function iosCommand(dir: string, entry: string, derived: string): string {
  const ws = entry.endsWith('.xcworkspace')
  const gen = entry === 'project.yml'
  const scheme = gen ? '$(sed -n "s/^name:[[:space:]]*//p" project.yml | head -1)' : basename(entry).replace(/\.(xcodeproj|xcworkspace)$/, '')
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const lines = [
    'set -e',
    ...(dir ? [`cd ${q(dir)}`] : []),
    `SCHEME="${scheme}"`,
    ...(gen ? ['command -v xcodegen >/dev/null && xcodegen generate --quiet', 'PROJ="$SCHEME.xcodeproj"'] : []),
    `DD=${q(derived)}`,
    `xcodebuild ${ws ? `-workspace ${q(entry)}` : `-project ${gen ? '"$PROJ"' : q(entry)}`} -scheme "$SCHEME" -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" build`,
    'APP=$(find "$DD/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name "*.app" | head -1)',
    'BUNDLE=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist")',
    'if ! xcrun simctl list devices booted | grep -q Booted; then xcrun simctl boot "$(xcrun simctl list devices available | grep -m1 iPhone | grep -oE "[0-9A-F-]{36}")"; fi',
    'open -a Simulator',
    'xcrun simctl install booted "$APP"',
    'exec xcrun simctl launch --console-pty --terminate-running-process booted "$BUNDLE"'
  ]
  return lines.join('\n')
}

async function iosTargets(cwd: string, dirs: readonly string[], fs: DevTargetFs): Promise<DevTarget[]> {
  const out: DevTarget[] = []
  for (const dir of dirs) {
    const entries = await fs.list(join(cwd, dir))
    const workspaces = entries.filter((e) => e.endsWith('.xcworkspace'))
    const projects = entries.filter((e) => e.endsWith('.xcodeproj') && !workspaces.includes(e.replace(/\.xcodeproj$/, '.xcworkspace')))
    const picks = workspaces.length ? workspaces : projects.length ? projects : entries.includes('project.yml') ? ['project.yml'] : []
    for (const entry of picks) {
      const scheme = entry === 'project.yml' ? (/^name:\s*(\S+)/m.exec((await fs.read(join(cwd, dir, entry))) ?? '')?.[1] ?? null) : entry.replace(/\.(xcodeproj|xcworkspace)$/, '')
      if (!scheme) continue
      const id = `ios:${dir || '.'}/${entry}`
      const derived = join(cwd, '.temp-code', 'dev-server', `ios-${scheme}`)
      out.push({ id, name: scheme, script: scheme, kind: 'ios', framework: 'xcode', dir, command: iosCommand(dir, entry, derived), macOnly: true })
    }
  }
  return out
}

/** `dir` and the folders under it to `depth`, skipping build output and dot dirs; at most 200. */
async function subdirs(cwd: string, dir: string, depth: number, fs: DevTargetFs): Promise<string[]> {
  const out = [dir]
  let level = [dir]
  for (let d = 0; d < depth && out.length < 200; d++) {
    const next: string[] = []
    for (const parent of level) {
      for (const e of await fs.list(join(cwd, parent))) {
        if (SKIP_DIRS.has(e) || e.startsWith('.') || /\.(xcodeproj|xcworkspace|app|framework|bundle)$/.test(e)) continue
        const child = parent ? `${parent}/${e}` : e
        if (await fs.isDir(join(cwd, child))) next.push(child)
      }
    }
    out.push(...next.slice(0, 200 - out.length))
    level = next
  }
  return out
}

/** Every target in a project checkout, root first. */
export async function detectDevTargets(cwd: string, projectName: string, fs: DevTargetFs = nodeFs): Promise<DevTarget[]> {
  const rootEntries = await fs.list(cwd)
  const run = runnerOf(rootEntries)
  const root = parseJson(await fs.read(join(cwd, 'package.json')))
  const out: DevTarget[] = []
  if (root) out.push(...scriptTargets('', root, projectName, run))

  const ws = root?.workspaces
  let patterns = Array.isArray(ws) ? ws : (ws?.packages ?? [])
  if (!patterns.length) patterns = pnpmPackages(await fs.read(join(cwd, 'pnpm-workspace.yaml')))
  if (!patterns.length) patterns = ['apps/*', 'packages/*']
  const pkgDirs = (await expand(cwd, patterns, fs)).slice(0, MAX_PACKAGES)
  const expoDirs = new Set<string>(usesExpo(root) ? [''] : [])
  for (const dir of pkgDirs) {
    const pkg = parseJson(await fs.read(join(cwd, dir, 'package.json')))
    if (!pkg) continue
    if (usesExpo(pkg)) expoDirs.add(dir)
    out.push(...scriptTargets(dir, pkg, pkg.name?.replace(/^@[^/]+\//, '') || basename(dir), run))
  }

  // Xcode apps at the root and up to two folders down (ios/App/project.yml), never inside an Expo app (its ios/ is generated).
  const iosDirs = expoDirs.has('') ? [] : (await subdirs(cwd, '', 2, fs)).filter((d) => ![...expoDirs].some((e) => e && (d === e || d.startsWith(`${e}/`))))
  out.push(...(await iosTargets(cwd, iosDirs, fs)))
  return out
}
