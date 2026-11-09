import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import type { HistoryMapping } from '../pathMap'
import { SKILL_HARNESSES, generationDirName, skillDigest, type SkillHarness } from '@shared/skills'
import { writeSkillTreeSync } from '../skillFiles'
import type { SkillStore, StoredFile } from '../skillStore'
import { untilLoopIdle } from '../stalls'
import { localizeSkillFile, textKey, type TextContext } from './skillText'
import { planView, planViews, type ViewPlan } from './views'

/**
 * The skills each CLI gets, written out on every host (CLAUDE.md "Skills: one store,
 * materialized per host"):
 *
 *   <root>/<provider>/<view>@<12 hex>/skills/<name>/…   one generation
 *   <root>/<provider>/<view>                              symlink to the current one
 *
 * A generation's name is the hash of everything its bytes depend on (the
 * view's skills, the layout, the text map and the extras), so a folder of
 * a given name is complete once renamed in and never changes. It is built
 * beside its place and renamed in; an unchanged skill is hard-linked from
 * the view's current generation, and every file is read-only so an edit in
 * place can never reach a sibling generation. The drivers reach a scope's
 * current generation through a pointer of their own (pointers.ts:
 * `<root>/<provider>/scope/<key>`), refreshed on every `onPublished`; gc
 * spares what those pointers name.
 */

export const GENERATION_LAYOUT = 1
export const GENERATION_MANIFEST = '.tc-generation.json'
/** `{ "<provider>/<generation>": supersededAt }` under the root. */
export const GENERATIONS_LEDGER = 'generations.json'
export const SUPERSEDED_KEEP_MS = 24 * 60 * 60_000
export const GC_EVERY_MS = 60 * 60_000
/** `<root>/<provider>/scope/`: the drivers' scope pointers (pointers.ts), each a link to a generation of this provider. */
export const SCOPE_DIR = 'scope'
const SETTLE_TIMEOUT_MS = 10_000

export interface GenerationManifest {
  layout: number
  textKey: string
  /** name → the stored files' skillDigest, and the names its text mentions after the first pass */
  skills: Record<string, { digest: string; mentions: string[] }>
}

const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex')

/** `<view>@<12 hex>`: sha256 of the view digest, the layout, the text key and the extras' digest, so a name always means one content. */
export function generationName(plan: Pick<ViewPlan, 'view' | 'viewDigest'>, textKey: string, extrasDigest: string): string {
  return generationDirName(plan.view, sha256Hex(`${plan.viewDigest}\0${GENERATION_LAYOUT}\0${textKey}\0${extrasDigest}`))
}

/** The digest of the extras a provider's generation carries beside skills/: '' with none. */
export function extrasDigest(extras: readonly { path: string; bytes: Uint8Array }[]): string {
  if (extras.length === 0) return ''
  return sha256Hex(
    extras
      .map((e) => `${e.path}\0${sha256Hex(e.bytes)}\n`)
      .sort()
      .join('')
  )
}

export interface MaterializerDeps {
  /** <userData>/harness */
  root: string
  skills: Pick<SkillStore, 'list' | 'files' | 'onChange'>
  workspaces: () => { id: string; path: string }[]
  platform: string
  home: string
  /** skillTextMap over memory sync's heard peers */
  textMap: () => HistoryMapping
  /** memory sync's onPeerHome: the map moved */
  onTextMap?: (fn: () => void) => () => void
  /** Generation paths a live CLI points at; filled by the drivers thread. */
  inUse?: () => ReadonlySet<string>
  /** Files beside skills/ that a provider's pointer needs (a plugin manifest); filled per the spike. */
  generationExtras?: (provider: SkillHarness) => { path: string; bytes: Uint8Array }[]
  now?: () => number
  /** Awaited between skills of an async build; default: a turn of the loop, then a quiet loop. */
  between?: () => Promise<void>
  log?: (line: string) => void
}

type Steps = Generator<void, BuildResult, void>
type BuildResult = { name: string; dir: string; written: number; linked: number; built: boolean; stale: boolean; swapped: boolean }

const GENERATION_RE = /^(.+)@([0-9a-f]{12})$/
const LEFTOVER_RE = /\.(tmp|lnk)-(\d+)-\d+$/

export class SkillMaterializer {
  private seq = 0
  private dirty = false
  private running: Promise<void> | null = null
  private closed = false
  private readonly offs: (() => void)[] = []
  private gcTimer: NodeJS.Timeout | null = null
  private settled: (() => void)[] = []
  /** A real folder found where a view's symlink belongs: said once. */
  private readonly foreign = new Set<string>()
  private readonly published = new Set<() => void>()

  constructor(private readonly deps: MaterializerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[skills] ${l}`)))(line)
  }

  // ── the lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.closed) return
    mkdirSync(this.deps.root, { recursive: true })
    this.removeLeftovers()
    this.offs.push(this.deps.skills.onChange(() => this.markDirty()))
    if (this.deps.onTextMap) this.offs.push(this.deps.onTextMap(() => this.markDirty()))
    this.markDirty()
    this.gc()
    this.gcTimer = setInterval(() => this.gc(), GC_EVERY_MS)
    this.gcTimer.unref?.()
  }

  close(): void {
    this.closed = true
    for (const off of this.offs.splice(0)) off()
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = null
    this.dirty = false
    this.release()
  }

  /** Resolves true once no run is pending or in flight, false at the timeout. */
  whenSettled(timeoutMs = SETTLE_TIMEOUT_MS): Promise<boolean> {
    if (!this.dirty && !this.running) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
      this.settled.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private release(): void {
    for (const fn of this.settled.splice(0)) fn()
  }

  /** `fn` after every run, whatever it changed, and after `dirFor` built a generation itself: what a view reads may have moved. */
  onPublished(fn: () => void): () => void {
    this.published.add(fn)
    return () => this.published.delete(fn)
  }

  private publish(): void {
    for (const fn of [...this.published]) {
      try {
        fn()
      } catch (err) {
        this.log(`a published listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private markDirty(): void {
    if (this.closed) return
    this.dirty = true
    if (this.running) return
    this.running = (async () => {
      // The next tick: a burst of writes is one run.
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        while (this.dirty && !this.closed) {
          this.dirty = false
          await this.runOnce()
        }
      } catch (err) {
        this.log(`write-out failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.running = null
        if (!this.dirty) this.release()
        else this.markDirty()
      }
    })()
  }

  // ── what a driver reads ────────────────────────────────────────────────

  /** The current generation of the view a `provider` thread in `workspaceId` reads, built now (with no yield) when a change is still pending. */
  dirFor(provider: SkillHarness, workspaceId: string | null): string {
    const plan = planView(this.deps.skills.list(), provider, workspaceId)
    const name = this.nameFor(plan)
    const dir = join(this.providerDir(provider), name)
    if (this.currentOf(provider, plan.view) === name && existsSync(dir)) return dir
    const result = drive(this.build(plan))
    this.publish()
    if (result.stale) {
      // Only a store whose files disagree with their row gets here: the view as it stands is the best answer.
      const current = this.currentOf(provider, plan.view)
      if (current) return join(this.providerDir(provider), current)
    }
    return dir
  }

  // ── one run ────────────────────────────────────────────────────────────

  private async runOnce(): Promise<void> {
    const plans = planViews(
      this.deps.skills.list(),
      this.deps.workspaces().map((w) => w.id)
    )
    const between = this.deps.between ?? defaultBetween
    for (const plan of plans) {
      if (this.closed) return
      const name = this.nameFor(plan)
      if (this.currentOf(plan.provider, plan.view) === name && existsSync(join(this.providerDir(plan.provider), name))) continue
      const result = await driveAsync(this.build(plan), between)
      if (result.stale || !result.swapped) continue
      this.log(`${plan.provider}/${plan.view} → ${result.name} (${result.written} written, ${result.linked} linked)`)
    }
    // A view no longer planned (a workspace that lost its last own skill, or was deleted) loses its symlink:
    // planned afresh, since a write during the yields above may have given a workspace its own view (dirFor links it at once).
    const planned = new Set(
      planViews(
        this.deps.skills.list(),
        this.deps.workspaces().map((w) => w.id)
      ).map((p) => `${p.provider}/${p.view}`)
    )
    for (const provider of SKILL_HARNESSES) {
      for (const view of this.viewsOnDisk(provider)) {
        if (planned.has(`${provider}/${view}`)) continue
        const current = this.currentOf(provider, view)
        rmSync(join(this.providerDir(provider), view), { force: true })
        if (current) this.markSuperseded(provider, current)
        this.log(`${provider}/${view} removed`)
      }
    }
    if (!this.closed) this.publish()
  }

  private providerDir(provider: SkillHarness): string {
    return join(this.deps.root, provider)
  }

  private textContext(plan: ViewPlan): TextContext {
    return {
      home: this.deps.home,
      textMap: this.deps.textMap(),
      viewSkillsDir: join(this.providerDir(plan.provider), plan.view, 'skills'),
      names: new Set(plan.skills.map((s) => s.name))
    }
  }

  private extras(provider: SkillHarness): { path: string; bytes: Uint8Array }[] {
    return this.deps.generationExtras?.(provider) ?? []
  }

  private nameFor(plan: ViewPlan, ctx: TextContext = this.textContext(plan), extras = this.extras(plan.provider)): string {
    return generationName(plan, textKey(ctx), extrasDigest(extras))
  }

  /** The generation `<view>` points at, or null. */
  private currentOf(provider: SkillHarness, view: string): string | null {
    try {
      const target = readlinkSync(join(this.providerDir(provider), view))
      return GENERATION_RE.test(target) ? target : null
    } catch {
      return null
    }
  }

  /** The views whose symlink is on disk for a provider. */
  private viewsOnDisk(provider: SkillHarness): string[] {
    try {
      return readdirSync(this.providerDir(provider), { withFileTypes: true })
        .filter((d) => d.isSymbolicLink() && !LEFTOVER_RE.test(d.name) && !GENERATION_RE.test(d.name))
        .map((d) => d.name)
    } catch {
      return []
    }
  }

  // ── building one generation ────────────────────────────────────────────

  /** One view's generation, a step per skill (the async driver yields between them); the symlink swapped when it is still the view's wanted one. */
  private *build(plan: ViewPlan): Steps {
    const ctx = this.textContext(plan)
    const extras = this.extras(plan.provider)
    const tk = textKey(ctx)
    const name = generationName(plan, tk, extrasDigest(extras))
    const providerDir = this.providerDir(plan.provider)
    const dir = join(providerDir, name)
    const result: BuildResult = { name, dir, written: 0, linked: 0, built: false, stale: false, swapped: false }
    if (!existsSync(dir)) {
      mkdirSync(providerDir, { recursive: true })
      const tmp = `${dir}.tmp-${process.pid}-${++this.seq}`
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(join(tmp, 'skills'), { recursive: true })
      // The view's current generation: an unchanged skill is linked from there.
      const prevName = this.currentOf(plan.provider, plan.view)
      const prev = prevName ? readManifest(join(providerDir, prevName)) : null
      const reusable = prev && prev.layout === GENERATION_LAYOUT && prev.textKey === tk ? prev : null
      const prevNames = new Set(Object.keys(reusable?.skills ?? {}))
      const manifest: GenerationManifest = { layout: GENERATION_LAYOUT, textKey: tk, skills: {} }
      try {
        for (const skill of plan.skills) {
          yield
          const was = reusable?.skills[skill.name]
          const inView = (n: string): boolean => ctx.names.has(n)
          const sameMentions = was && was.mentions.filter(inView).join('\0') === was.mentions.filter((n) => prevNames.has(n)).join('\0')
          const target = join(tmp, 'skills', skill.name)
          if (was && was.digest === skill.digest && sameMentions && prevName) {
            linkTree(join(providerDir, prevName, 'skills', skill.name), target)
            manifest.skills[skill.name] = was
            result.linked++
            continue
          }
          const files = this.deps.skills.files(skill.id)
          if (skillDigest(files) !== skill.digest) {
            // Rewritten since the plan: the run that change scheduled builds the newer rows.
            result.stale = true
            return result
          }
          const mentions = new Set<string>()
          const out: StoredFile[] = files.map((f) => {
            const local = localizeSkillFile(f, ctx)
            for (const m of local.mentions) mentions.add(m)
            return local.file
          })
          writeSkillTreeSync(target, out, { readOnly: true })
          manifest.skills[skill.name] = { digest: skill.digest, mentions: [...mentions].sort() }
          result.written++
        }
        if (extras.length) writeSkillTreeSync(tmp, extras.map((e) => ({ path: e.path, bytes: e.bytes, executable: false })), { readOnly: true })
        writeFileSync(join(tmp, GENERATION_MANIFEST), JSON.stringify(manifest), { mode: 0o444 })
        try {
          renameSync(tmp, dir)
          result.built = true
        } catch (err) {
          // The other build path got there first: the same name holds the same bytes.
          if (!existsSync(dir)) throw err
        }
      } finally {
        if (result.stale || !result.built) rmSync(tmp, { recursive: true, force: true })
      }
    }
    result.swapped = this.swapIfWanted(plan, name)
    return result
  }

  /** Point `<view>` at `name` when a fresh plan of the view still wants it; the previous generation is superseded from now. */
  private swapIfWanted(plan: ViewPlan, name: string): boolean {
    const now = planView(this.deps.skills.list(), plan.provider, plan.workspaceId)
    if (now.view !== plan.view || this.nameFor(now) !== name) return false
    const providerDir = this.providerDir(plan.provider)
    const link = join(providerDir, plan.view)
    const st = lstatOrNull(link)
    if (st && !st.isSymbolicLink()) {
      if (!this.foreign.has(link)) this.log(`${link} is a folder, not the app's link; left as it is`)
      this.foreign.add(link)
      return false
    }
    const prev = this.currentOf(plan.provider, plan.view)
    if (prev === name) return true
    const tmp = `${link}.lnk-${process.pid}-${++this.seq}`
    rmSync(tmp, { force: true })
    symlinkSync(name, tmp)
    renameSync(tmp, link)
    const ledger = this.readLedger()
    delete ledger[`${plan.provider}/${name}`]
    if (prev) ledger[`${plan.provider}/${prev}`] = this.now()
    this.writeLedger(ledger)
    return true
  }

  // ── old generations ────────────────────────────────────────────────────

  private readLedger(): Record<string, number> {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.root, GENERATIONS_LEDGER), 'utf8')) as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  private writeLedger(ledger: Record<string, number>): void {
    const path = join(this.deps.root, GENERATIONS_LEDGER)
    const tmp = `${path}.tmp-${process.pid}-${++this.seq}`
    writeFileSync(tmp, JSON.stringify(ledger))
    renameSync(tmp, path)
  }

  private markSuperseded(provider: SkillHarness, name: string): void {
    const ledger = this.readLedger()
    ledger[`${provider}/${name}`] ??= this.now()
    this.writeLedger(ledger)
  }

  /** The generations the scope pointers name (pointers.ts writes them as `../<generation>`). */
  private pointed(provider: SkillHarness): Set<string> {
    const out = new Set<string>()
    const dir = join(this.providerDir(provider), SCOPE_DIR)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return out
    }
    for (const name of names) {
      try {
        const target = basename(readlinkSync(join(dir, name)))
        if (GENERATION_RE.test(target)) out.add(target)
      } catch {
        // not a link: nothing it names
      }
    }
    return out
  }

  /** Remove each generation no view or scope pointer points at, no live CLI holds, superseded more than a day ago. */
  gc(): void {
    try {
      const ledger = this.readLedger()
      const inUse = this.deps.inUse?.() ?? new Set<string>()
      const now = this.now()
      const seen = new Set<string>()
      for (const provider of SKILL_HARNESSES) {
        const dir = this.providerDir(provider)
        let entries: string[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && GENERATION_RE.test(d.name))
            .map((d) => d.name)
        } catch {
          continue
        }
        const currents = new Set<string | null>([...this.viewsOnDisk(provider).map((v) => this.currentOf(provider, v)), ...this.pointed(provider)])
        for (const name of entries) {
          const key = `${provider}/${name}`
          seen.add(key)
          if (currents.has(name) || inUse.has(join(dir, name))) {
            delete ledger[key]
            continue
          }
          const since = (ledger[key] ??= now)
          if (now - since <= SUPERSEDED_KEEP_MS) continue
          rmSync(join(dir, name), { recursive: true, force: true })
          delete ledger[key]
          seen.delete(key)
        }
      }
      for (const key of Object.keys(ledger)) if (!seen.has(key)) delete ledger[key]
      this.writeLedger(ledger)
    } catch (err) {
      this.log(`gc failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** What a process that died mid-build left: its tmp folders and links. */
  private removeLeftovers(): void {
    for (const dir of [this.deps.root, ...SKILL_HARNESSES.map((p) => this.providerDir(p))]) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const m = LEFTOVER_RE.exec(name)
        if (m && Number(m[2]) !== process.pid) rmSync(join(dir, name), { recursive: true, force: true })
      }
    }
  }
}

const defaultBetween = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await untilLoopIdle()
}

function drive(steps: Steps): BuildResult {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

async function driveAsync(steps: Steps, between: () => Promise<void>): Promise<BuildResult> {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
    await between()
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readManifest(dir: string): GenerationManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, GENERATION_MANIFEST), 'utf8')) as GenerationManifest
    return m && typeof m.layout === 'number' && typeof m.textKey === 'string' && m.skills ? m : null
  } catch {
    return null
  }
}

/** `from`'s tree at `to`: a folder for each folder, a hard link for each file, a copy where the file system refuses a link. */
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) {
      linkTree(src, dst)
      continue
    }
    try {
      linkSync(src, dst)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM') throw err
      copyFileSync(src, dst)
      chmodSync(dst, statSync(src).mode & 0o777)
    }
  }
}

// ── the one instance the drivers read ────────────────────────────────────

let configured: SkillMaterializer | null = null

export function configureMaterializedSkills(m: SkillMaterializer | null): void {
  configured = m
}

/** The generation a `provider` CLI in `workspaceId` points at; null before the materializer is configured (tests, a host without the store). */
export function materializedSkillsDir(provider: SkillHarness, workspaceId: string | null): string | null {
  return configured ? configured.dirFor(provider, workspaceId) : null
}

