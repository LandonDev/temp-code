import { randomUUID } from 'node:crypto'
import type { ClientRequest } from '@shared/contract'
import type {
  SessionImportBeginAnswer,
  SessionMoveFrame,
  SessionMoveManifest,
  SessionMoveResult,
  SessionMoveRowState
} from '@shared/contract-session-move'
import {
  MoveExport,
  MoveImports,
  claimLanding,
  dropLanding,
  frozenIds,
  moveStatus,
  setMovingTo,
  subtreeIds,
  tombstone,
  type MoveHost
} from '../sessionMove'
import type { PeerLink, Peers } from './peers'

/**
 * Moving one thread between hosts, the protocol half (docs/box.md "Moving a
 * thread between hosts"; sessionMove.ts is the data half). The desktop is
 * the only UI and the only host that dials, so every move starts on its own
 * server (`session.move`, local) and runs over its admin peer link:
 *
 *  - push (this host → a peer): freeze the subtree here (`moving_to`), send
 *    the manifest and every part to `session.import.*` there, ask it to
 *    commit; on the echoed digest keep a tombstone here, tell the clients
 *    where the thread went, then release the landing there.
 *  - pull (a peer → this host): `session.export.begin` freezes it there and
 *    answers the manifest; pull every part, land it here hidden, commit
 *    locally, send the digest to `session.export.commit` (the peer keeps the
 *    tombstone on a match), then claim the landing here.
 *  - settle, on every link-up (accountSync.settle's shape): a landing whose
 *    source is still live is dropped, a landing whose source is a tombstone
 *    is claimed, and a freeze nobody finishes is lifted.
 *
 * The two-phase order is the account handoff's: the source strips only on
 * the receiver's echo, the receiver becomes the owner only after that, and
 * whichever message is lost leaves a state the next settle finishes.
 */

const STEP_TIMEOUT_MS = 120_000
/** A peer's export or landing that nobody touched for this long is let go. */
const IDLE_MS = 10 * 60_000

export interface SessionMoverRegistry {
  freezeForMove(rootId: string, freeze: (ids: string[]) => void): Promise<string[]>
  departed(rootId: string, ids: string[], to: string): Promise<void>
  arrived(ids: string[]): void
  thawed(ids: string[]): void
  rootSessionOf(sessionId: string): string
}

export interface SessionMoverDeps {
  host: MoveHost
  registry: SessionMoverRegistry
  peers: Pick<Peers, 'get' | 'all'>
  /** Flush buffered event rows before an export reads the log. */
  flush?: () => void
  log?: (line: string) => void
  idleMs?: number
}

interface ExportState {
  exp: MoveExport
  ids: string[]
  to: string
  timer: NodeJS.Timeout | null
}

export class SessionMover {
  readonly imports: MoveImports
  private readonly exports = new Map<string, ExportState>()
  /** Ids a move this process drives (or answers) holds right now: settle leaves them alone. */
  private readonly busy = new Set<string>()
  private readonly importTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly deps: SessionMoverDeps) {
    this.imports = new MoveImports(deps.host)
  }

  private get me(): string {
    return this.deps.host.environmentId
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[session-move] ${l}`)))(line)
  }

  private link(id: string): PeerLink {
    const link = this.deps.peers.get(id)
    if (!link) throw new Error(`${id} is not a host this one holds an admin key for`)
    if (!link.connected) throw new Error(`${link.env.name} is not connected`)
    return link
  }

  // ── the desktop's call ────────────────────────────────────────────────

  async move(params: { sessionId: string; to: string; from?: string }): Promise<SessionMoveResult> {
    const from = params.from ?? this.me
    if (from === params.to) throw new Error('the thread is already on that host')
    if (from === this.me) return this.push(params.sessionId, params.to)
    if (params.to === this.me) return this.pull(params.sessionId, from)
    throw new Error('a thread moves between this host and another; move it here first')
  }

  private async push(sessionId: string, to: string): Promise<SessionMoveResult> {
    const { host, registry } = this.deps
    const link = this.link(to)
    const rootId = registry.rootSessionOf(sessionId)
    if (rootId !== sessionId) throw new Error('a subagent moves with its thread; move the thread')
    const moveId = randomUUID()
    const ids = await registry.freezeForMove(rootId, (frozen) => setMovingTo(host.db, frozen, to, moveId))
    for (const id of ids) this.busy.add(id)
    try {
      let exp: MoveExport
      let landed: SessionImportBeginAnswer
      try {
        this.deps.flush?.()
        exp = await MoveExport.build(host, rootId, moveId, to)
        landed = await link.request<SessionImportBeginAnswer>('session.import.begin', { manifest: exp.manifest }, { timeoutMs: STEP_TIMEOUT_MS })
        for (let i = 0; i < exp.manifest.parts; i++) await link.request('session.import.part', exp.part(i), { timeoutMs: STEP_TIMEOUT_MS })
        const answer = await link.request<{ digest: string }>('session.import.commit', { moveId, digest: exp.digest() }, { timeoutMs: STEP_TIMEOUT_MS })
        if (answer.digest !== exp.digest()) throw new Error(`${link.env.name} holds something else than what was sent`)
      } catch (err) {
        // The source is still whole here: the landing there goes, the freeze lifts.
        await link.request('session.import.abort', { moveId, sessionId: rootId }).catch(() => undefined)
        setMovingTo(host.db, ids, null, null)
        registry.thawed(ids)
        throw err
      }
      tombstone(host, ids, to)
      await registry.departed(rootId, ids, to)
      let pendingRelease = false
      try {
        await link.request('session.import.release', { moveId, sessionId: rootId }, { timeoutMs: STEP_TIMEOUT_MS })
      } catch (err) {
        pendingRelease = true
        this.log(`${rootId}: release on ${link.env.name} did not answer (${(err as Error).message}); the next link-up settles it`)
      }
      this.log(`${rootId} moved to ${link.env.name}: ${ids.length} session(s), ${exp.manifest.parts} part(s)`)
      return this.result(exp.manifest, landed.cwd, pendingRelease)
    } finally {
      for (const id of ids) this.busy.delete(id)
    }
  }

  private async pull(sessionId: string, from: string): Promise<SessionMoveResult> {
    const { host, registry } = this.deps
    const link = this.link(from)
    const moveId = randomUUID()
    const manifest = await link.request<SessionMoveManifest>('session.export.begin', { sessionId, moveId, to: this.me }, { timeoutMs: STEP_TIMEOUT_MS })
    const ids = manifest.sessions.map((s) => String(s.id))
    for (const id of ids) this.busy.add(id)
    try {
      let digest: string
      let landed: SessionImportBeginAnswer
      try {
        landed = this.imports.begin(manifest)
        for (let i = 0; i < manifest.parts; i++) {
          const frame = await link.request<SessionMoveFrame>('session.export.part', { moveId, index: i }, { timeoutMs: STEP_TIMEOUT_MS })
          this.imports.part(frame)
        }
        digest = this.imports.commit(moveId, null).digest
      } catch (err) {
        this.imports.forget(moveId)
        dropLanding(host, { moveId })
        await link.request('session.export.abort', { moveId, sessionId: manifest.rootId }).catch(() => undefined)
        throw err
      }
      let stripped = false
      try {
        const answer = await link.request<{ digest: string }>('session.export.commit', { moveId, digest }, { timeoutMs: STEP_TIMEOUT_MS })
        stripped = answer.digest === digest
        if (!stripped) throw new Error(`${link.env.name} sent something else than what landed`)
      } catch (err) {
        // Did the source keep a tombstone before the answer went missing?
        const status = await link
          .request<{ rows: SessionMoveRowState[] }>('session.move.status', { environmentId: this.me, ids: [manifest.rootId] }, { timeoutMs: STEP_TIMEOUT_MS })
          .catch(() => null)
        const root = status?.rows.find((r) => r.id === manifest.rootId)
        if (root?.state === 'tombstone' && root.peer === this.me) stripped = true
        else if (root) {
          dropLanding(host, { moveId })
          await link.request('session.export.abort', { moveId, sessionId: manifest.rootId }).catch(() => undefined)
          throw err
        } else throw new Error(`the move did not finish (${(err as Error).message}); it settles when ${link.env.name} answers again`)
      }
      const claimed = claimLanding(host, { moveId, sessionId: manifest.rootId })
      registry.arrived(claimed)
      this.log(`${manifest.rootId} moved here from ${link.env.name}: ${ids.length} session(s), ${manifest.parts} part(s)`)
      return this.result(manifest, landed.cwd, false)
    } finally {
      for (const id of ids) this.busy.delete(id)
    }
  }

  private result(m: SessionMoveManifest, cwd: string, pendingRelease: boolean): SessionMoveResult {
    const carried = m.files.some((f) => f.kind !== 'html')
    return {
      sessionId: m.rootId,
      sessionIds: m.sessions.map((s) => String(s.id)),
      from: m.from,
      to: m.to,
      cwd,
      events: Object.values(m.events).reduce((a, b) => a + b, 0),
      files: m.files.length,
      transcript: m.transcriptMissing.length ? 'missing' : carried ? 'moved' : 'none',
      dirty: m.dirty,
      dirtyMore: m.dirtyMore,
      checkpointsStayed: m.checkpoints,
      ...(pendingRelease ? { pendingRelease } : {})
    }
  }

  // ── a peer's side: the receiver of a push ──────────────────────────────

  private touchImport(moveId: string): void {
    const old = this.importTimers.get(moveId)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => {
      this.importTimers.delete(moveId)
      if (!this.imports.active.includes(moveId)) return
      this.imports.forget(moveId)
      const dropped = dropLanding(this.deps.host, { moveId })
      this.log(`landing ${moveId} went idle; dropped ${dropped.length} row(s)`)
    }, this.deps.idleMs ?? IDLE_MS)
    timer.unref()
    this.importTimers.set(moveId, timer)
  }

  private untouchImport(moveId: string): void {
    const t = this.importTimers.get(moveId)
    if (t) clearTimeout(t)
    this.importTimers.delete(moveId)
  }

  importBegin(manifest: SessionMoveManifest): SessionImportBeginAnswer {
    const answer = this.imports.begin(manifest)
    this.touchImport(manifest.moveId)
    return answer
  }

  importPart(frame: SessionMoveFrame): { index: number } {
    this.touchImport(frame.moveId)
    return this.imports.part(frame)
  }

  importCommit(moveId: string, digest: string): { digest: string } {
    this.untouchImport(moveId)
    return this.imports.commit(moveId, digest)
  }

  importRelease(params: { moveId?: string; sessionId: string }): { sessionIds: string[] } {
    const ids = claimLanding(this.deps.host, params)
    if (ids.length) this.deps.registry.arrived(ids)
    return { sessionIds: ids }
  }

  importAbort(params: { moveId?: string; sessionId?: string }): { dropped: number } {
    if (params.moveId) {
      this.untouchImport(params.moveId)
      this.imports.forget(params.moveId)
    }
    let dropped = params.moveId ? dropLanding(this.deps.host, { moveId: params.moveId }) : []
    if (dropped.length === 0 && params.sessionId) dropped = dropLanding(this.deps.host, { sessionId: params.sessionId })
    return { dropped: dropped.length }
  }

  // ── a peer's side: the source of a pull ────────────────────────────────

  private touchExport(moveId: string): void {
    const state = this.exports.get(moveId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      this.log(`export ${moveId} went idle; the thread stays here`)
      this.exportAbort({ moveId })
    }, this.deps.idleMs ?? IDLE_MS)
    state.timer.unref()
  }

  async exportBegin(params: { sessionId: string; moveId: string; to: string }): Promise<SessionMoveManifest> {
    const { host, registry } = this.deps
    // The caller is another host's main process (the box never dials the Mac, so `to` need not be a peer here).
    if (params.to === this.me) throw new Error('the thread is already on this host')
    const rootId = registry.rootSessionOf(params.sessionId)
    if (rootId !== params.sessionId) throw new Error('a subagent moves with its thread; move the thread')
    const ids = await registry.freezeForMove(rootId, (frozen) => setMovingTo(host.db, frozen, params.to, params.moveId))
    try {
      this.deps.flush?.()
      const exp = await MoveExport.build(host, rootId, params.moveId, params.to)
      this.exports.set(params.moveId, { exp, ids, to: params.to, timer: null })
      this.touchExport(params.moveId)
      return exp.manifest
    } catch (err) {
      setMovingTo(host.db, ids, null, null)
      registry.thawed(ids)
      throw err
    }
  }

  exportPart(moveId: string, index: number): SessionMoveFrame {
    const state = this.exports.get(moveId)
    if (!state) throw new Error(`no export ${moveId} here`)
    this.touchExport(moveId)
    return state.exp.part(index)
  }

  async exportCommit(moveId: string, digest: string): Promise<{ digest: string }> {
    const state = this.exports.get(moveId)
    if (!state) throw new Error(`no export ${moveId} here`)
    const mine = state.exp.digest()
    if (mine !== digest) throw new Error('session.export.commit: the digest does not match what was sent')
    if (state.timer) clearTimeout(state.timer)
    this.exports.delete(moveId)
    tombstone(this.deps.host, state.ids, state.to)
    await this.deps.registry.departed(state.exp.manifest.rootId, state.ids, state.to)
    this.log(`${state.exp.manifest.rootId} moved to ${state.to}`)
    return { digest: mine }
  }

  exportAbort(params: { moveId?: string; sessionId?: string }): { thawed: number } {
    const state = params.moveId ? this.exports.get(params.moveId) : undefined
    if (state?.timer) clearTimeout(state.timer)
    if (params.moveId) this.exports.delete(params.moveId)
    let ids = state?.ids ?? (params.moveId ? frozenIds(this.deps.host.db, { moveId: params.moveId }) : [])
    if (ids.length === 0 && params.sessionId) ids = frozenIds(this.deps.host.db, { sessionId: params.sessionId })
    if (ids.length === 0) return { thawed: 0 }
    setMovingTo(this.deps.host.db, ids, null, null)
    this.deps.registry.thawed(ids)
    return { thawed: ids.length }
  }

  status(environmentId: string, ids: string[]): { rows: SessionMoveRowState[] } {
    return { rows: moveStatus(this.deps.host.db, environmentId, ids) }
  }

  // ── settle ─────────────────────────────────────────────────────────────

  /** Finish what a lost message left half done between this host and `peerId`. */
  async settleWith(peerId: string): Promise<void> {
    const link = this.deps.peers.get(peerId)
    if (!link?.connected) return
    const { host, registry } = this.deps
    const db = host.db
    const local = moveStatus(db, peerId, [])
    let remote: SessionMoveRowState[]
    try {
      remote = (await link.request<{ rows: SessionMoveRowState[] }>('session.move.status', { environmentId: this.me, ids: local.map((r) => r.id) }, { timeoutMs: STEP_TIMEOUT_MS })).rows
    } catch (err) {
      // An older host without moves answers "bad request": nothing to settle there.
      if (!/bad request|unknown method|invalid/i.test((err as Error).message)) this.log(`settle with ${link.env.name}: ${(err as Error).message}`)
      return
    }
    const remoteById = new Map(remote.map((r) => [r.id, r]))
    const ids = new Set([...local.map((r) => r.id), ...remote.map((r) => r.id)])
    const thaw: string[] = []
    const claim: string[] = []
    const drop: string[] = []
    const remoteCalls: [string, { sessionId: string }][] = []
    for (const id of ids) {
      if (this.busy.has(id)) continue
      const l = moveStatus(db, peerId, [id]).find((r) => r.id === id) ?? { id, state: 'absent' as const }
      const r = remoteById.get(id) ?? { id, state: 'absent' as const }
      const rPeerIsMe = 'peer' in r && r.peer === this.me
      const lPeerIsIt = 'peer' in l && l.peer === peerId
      if (l.state === 'exporting' && lPeerIsIt) {
        if (r.state === 'provisional' && rPeerIsMe) remoteCalls.push(['session.import.abort', { sessionId: id }])
        thaw.push(id)
      } else if (l.state === 'tombstone' && lPeerIsIt) {
        if (r.state === 'provisional' && rPeerIsMe) remoteCalls.push(['session.import.release', { sessionId: id }])
      } else if (l.state === 'provisional' && lPeerIsIt) {
        if ((r.state === 'tombstone' && rPeerIsMe) || r.state === 'absent') claim.push(id)
        else {
          drop.push(id)
          if (r.state === 'exporting' && rPeerIsMe) remoteCalls.push(['session.export.abort', { sessionId: id }])
        }
      } else if (r.state === 'provisional' && rPeerIsMe) {
        remoteCalls.push([l.state === 'absent' ? 'session.import.release' : 'session.import.abort', { sessionId: id }])
      } else if (r.state === 'exporting' && rPeerIsMe) {
        remoteCalls.push(['session.export.abort', { sessionId: id }])
      }
    }
    for (const [method, params] of remoteCalls) await link.request(method, params, { timeoutMs: STEP_TIMEOUT_MS }).catch((err: Error) => this.log(`settle ${method} ${params.sessionId} on ${link.env.name}: ${err.message}`))
    if (thaw.length) {
      setMovingTo(db, thaw, null, null)
      registry.thawed(thaw)
    }
    if (claim.length) {
      const st = db.prepare(`UPDATE sessions SET moving_from = NULL, move_id = NULL WHERE id = ?`)
      for (const id of claim) st.run(id)
      host.forget?.(claim)
      registry.arrived(claim)
    }
    for (const id of drop) dropLanding(host, { sessionId: id })
    const did = thaw.length + claim.length + drop.length + remoteCalls.length
    if (did) this.log(`settled with ${link.env.name}: ${thaw.length} thawed, ${claim.length} claimed, ${drop.length} dropped, ${remoteCalls.length} asked of it`)
  }

  /** At boot: a freeze belongs to a move that ran in the process that quit,
   *  and no move outlives its process, so every one lifts. A landing the
   *  peer still holds is dropped by the next settle (the source is live). */
  thawStale(): number {
    const db = this.deps.host.db
    const ids = (db.prepare(`SELECT id FROM sessions WHERE moving_to IS NOT NULL`).all() as { id: string }[]).map((r) => r.id)
    if (ids.length) setMovingTo(db, ids, null, null)
    return ids.length
  }

  /** Ids of a subtree here (tests). */
  subtree(rootId: string): string[] {
    return subtreeIds(this.deps.host.db, rootId)
  }

  close(): void {
    for (const t of this.importTimers.values()) clearTimeout(t)
    this.importTimers.clear()
    for (const s of this.exports.values()) if (s.timer) clearTimeout(s.timer)
  }
}

/** The `session.move*`, `session.import.*` and `session.export.*` requests, for the server's dispatch. */
export async function handleSessionMove(req: ClientRequest, mover: SessionMover): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'session.move':
      return { handled: true, result: await mover.move(req.params) }
    case 'session.import.begin':
      return { handled: true, result: mover.importBegin(req.params.manifest) }
    case 'session.import.part':
      return { handled: true, result: mover.importPart(req.params) }
    case 'session.import.commit':
      return { handled: true, result: mover.importCommit(req.params.moveId, req.params.digest) }
    case 'session.import.release':
      return { handled: true, result: mover.importRelease(req.params) }
    case 'session.import.abort':
      return { handled: true, result: mover.importAbort(req.params) }
    case 'session.export.begin':
      return { handled: true, result: await mover.exportBegin(req.params) }
    case 'session.export.part':
      return { handled: true, result: mover.exportPart(req.params.moveId, req.params.index) }
    case 'session.export.commit':
      return { handled: true, result: await mover.exportCommit(req.params.moveId, req.params.digest) }
    case 'session.export.abort':
      return { handled: true, result: mover.exportAbort(req.params) }
    case 'session.move.status':
      return { handled: true, result: mover.status(req.params.environmentId, req.params.ids) }
    default:
      return { handled: false }
  }
}
