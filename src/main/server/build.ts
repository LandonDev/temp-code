import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { glob } from 'tinyglobby'
import type { ServerPush } from '@shared/contract'
import {
  splitGlobs,
  type BuildConfig,
  type BuildOutput,
  type BuildRun,
  type EffectiveBuild
} from '@shared/build'
import { harnessEnv } from './drivers/binaries'

/**
 * The Build rail's engine: one build per project at a time, run in the
 * project checkout through the login shell (that is where mvn/java live),
 * log streamed in ~50 ms batches, a ring buffer for replay, and the files
 * the build produced resolved afterwards (configured globs, else paths
 * the log mentions).
 */

const LOG_CAP = 3000
const BATCH_MS = 50
const KILL_GRACE_MS = 5000

/** What a checkout's build tooling implies when nothing is configured. */
export async function detectBuild(cwd: string): Promise<BuildConfig | null> {
  const has = (name: string): boolean => existsSync(join(cwd, name))
  if (has('mvnw') || has('pom.xml')) {
    return {
      command: `${has('mvnw') ? './mvnw' : 'mvn'} -B -DskipTests package`,
      outputs: 'target/*.jar,!target/original-*.jar'
    }
  }
  if (has('gradlew') || has('build.gradle') || has('build.gradle.kts')) {
    return {
      command: `${has('gradlew') ? './gradlew' : 'gradle'} build`,
      outputs: 'build/libs/*.jar'
    }
  }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
      }
      if (pkg.scripts?.build) return { command: 'bun run build', outputs: '' }
    } catch {
      // unreadable package.json — nothing to detect
    }
  }
  return null
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const ARTIFACT =
  /[^\s"'`()[\]<>,;]+\.(?:jar|war|ear|zip|tar\.gz|tgz|dmg|pkg|exe|msi|apk|aar|whl|deb|rpm)(?![\w.])/g

/** Artifact-looking paths the log mentions, as checkout-relative paths. */
export function scanLog(lines: string[], cwd: string): string[] {
  const found = new Set<string>()
  for (const line of lines) {
    for (const token of line.match(ARTIFACT) ?? []) {
      const rel = relative(cwd, resolve(cwd, token))
      if (!rel.startsWith('..') && !rel.startsWith('/')) found.add(rel)
    }
  }
  return [...found]
}

/** Files a run produced: glob matches (or log mentions), fresh ones first. */
export async function resolveOutputs(
  cwd: string,
  outputs: string,
  lines: string[],
  startedAt: number
): Promise<BuildOutput[]> {
  const { include, exclude } = splitGlobs(outputs)
  let paths: string[] = []
  try {
    paths = include.length
      ? await glob(include, { cwd, ignore: exclude, onlyFiles: true })
      : scanLog(lines, cwd)
  } catch {
    // a bad glob yields no outputs rather than a failed build
  }
  const rows = await Promise.all(
    paths.map(async (path): Promise<BuildOutput | null> => {
      const abs = resolve(cwd, path)
      const st = await stat(abs).catch(() => null)
      if (!st?.isFile()) return null
      return {
        path,
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
        fresh: st.mtimeMs >= startedAt - 1000
      }
    })
  )
  return rows
    .filter((r): r is BuildOutput => r !== null)
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
}

type BuildPush = Extract<ServerPush, { push: 'build' }>

interface Slot {
  run: BuildRun
  cwd: string
  outputs: string
  lines: string[]
  child: ChildProcess | null
  pending: string[]
  timer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  cancelling: boolean
}

export class BuildRunner {
  private slots = new Map<string, Slot>()
  private listeners = new Set<(push: BuildPush) => void>()

  onPush(listener: (push: BuildPush) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Last run + buffered log for a project (panel replay). */
  status(projectId: string): { run: BuildRun | null; lines: string[] } {
    const slot = this.slots.get(projectId)
    return slot ? { run: slot.run, lines: slot.lines.slice() } : { run: null, lines: [] }
  }

  isRunning(projectId: string): boolean {
    return this.slots.get(projectId)?.run.status === 'running'
  }

  async run(projectId: string, cwd: string, build: EffectiveBuild): Promise<BuildRun> {
    if (this.isRunning(projectId)) throw new Error('a build is already running')
    const slot: Slot = {
      run: {
        id: nanoid(10),
        status: 'running',
        command: build.command,
        startedAt: Date.now(),
        outputs: []
      },
      cwd,
      outputs: build.outputs,
      lines: [],
      child: null,
      pending: [],
      timer: null,
      killTimer: null,
      cancelling: false
    }
    this.slots.set(projectId, slot)
    this.emit(projectId, slot, [])
    const env = { ...(await harnessEnv()), NO_COLOR: '1', TERM: 'dumb' }
    const child = spawn('/bin/zsh', ['-lc', build.command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    slot.child = child
    const feed = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      let rest = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop() ?? ''
        this.pushLines(projectId, slot, parts)
      })
      stream.on('end', () => {
        if (rest) this.pushLines(projectId, slot, [rest])
      })
    }
    feed(child.stdout)
    feed(child.stderr)
    child.on('error', (err) => {
      this.pushLines(projectId, slot, [err.message])
      void this.finish(projectId, slot, 'failed', null)
    })
    child.on('close', (code) => {
      void this.finish(projectId, slot, slot.cancelling ? 'cancelled' : code === 0 ? 'ok' : 'failed', code)
    })
    return slot.run
  }

  /** SIGTERM the whole process group (shell + mvn/java), SIGKILL after 5 s. */
  cancel(projectId: string): void {
    const slot = this.slots.get(projectId)
    const pid = slot?.child?.pid
    if (!slot || slot.run.status !== 'running' || !pid) return
    slot.cancelling = true
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig)
      } catch {
        slot.child?.kill(sig)
      }
    }
    signal('SIGTERM')
    slot.killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
  }

  disposeAll(): void {
    for (const projectId of this.slots.keys()) this.cancel(projectId)
  }

  private pushLines(projectId: string, slot: Slot, raw: string[]): void {
    const lines = raw.map((l) => l.replace(ANSI, '').replace(/\r$/, ''))
    slot.lines.push(...lines)
    if (slot.lines.length > LOG_CAP) slot.lines.splice(0, slot.lines.length - LOG_CAP)
    slot.pending.push(...lines)
    slot.timer ??= setTimeout(() => this.flush(projectId, slot), BATCH_MS)
  }

  private flush(projectId: string, slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    if (!slot.pending.length) return
    const lines = slot.pending
    slot.pending = []
    this.emit(projectId, slot, lines)
  }

  private async finish(
    projectId: string,
    slot: Slot,
    status: BuildRun['status'],
    code: number | null
  ): Promise<void> {
    if (slot.run.status !== 'running') return
    if (slot.killTimer) clearTimeout(slot.killTimer)
    slot.killTimer = null
    slot.child = null
    this.flush(projectId, slot)
    const outputs =
      status === 'cancelled'
        ? []
        : await resolveOutputs(slot.cwd, slot.outputs, slot.lines, slot.run.startedAt)
    slot.run = { ...slot.run, status, endedAt: Date.now(), exitCode: code ?? undefined, outputs }
    this.emit(projectId, slot, [])
  }

  private emit(projectId: string, slot: Slot, lines: string[]): void {
    const push: BuildPush = { push: 'build', projectId, run: slot.run, lines }
    for (const l of this.listeners) l(push)
  }
}
