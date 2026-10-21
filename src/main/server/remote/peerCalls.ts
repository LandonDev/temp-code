import { randomBytes } from 'node:crypto'
import type { ServerFrame } from '@shared/contract'
import { PEER_CHUNK_CHARS, PEER_MAX_CHUNKS, type MacBridgePush } from '@shared/contract-macbridge'
import type { MacPeerMethod } from '@shared/contract-macjobs'
import { ProgressOrder, progressSender, type ProgressFrame } from './peerStreams'

/**
 * Reverse RPC over the peer link (docs/box.md "The Mac bridge"). The Mac's
 * main process holds a socket open to the box's /ws (remote/peers.ts); the
 * box cannot dial the Mac, so the box asks over that same socket:
 *
 *   Mac → box  peer.register { from, offers, home? } the socket becomes the Mac's
 *   box → Mac  { push: 'peer.call', callId, method, params, deadlineMs }
 *   Mac → box  peer.progress { callId, seq, chunk }  × n, while it runs (mac.run; peerStreams.ts)
 *   Mac → box  peer.chunk { callId, index, data }    × n, when the reply is long
 *   Mac → box  peer.reply { callId, ok, result | error, chunks? }
 *
 * A reply is taken only from the socket the call went out on. Every call has
 * its own deadline (a command may run for minutes), and a socket that closes
 * fails its calls at once. The box side is `PeerCalls`; the Mac side is
 * `replyOverLink` and `servePeerCall`, which speak through PeerLink.request.
 */

/** One socket that registered: the connection the attach() loop numbered, and how to send on it. */
export interface PeerSocket {
  connection: number
  /** The remote key it authenticated with, for the log line. */
  keyId: string | null
  send: (frame: ServerFrame) => void
}

interface Registration {
  socket: PeerSocket
  offers: Set<string>
  /** The Mac's home directory, as it said in peer.register (an older Mac says nothing). */
  home?: string
  at: number
}

interface PendingCall {
  envId: string
  method: string
  connection: number
  chunks: (string | undefined)[]
  /** peer.progress frames, handed on in seq order (absent: the caller did not ask for them). */
  progress?: ProgressOrder
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class PeerOfflineError extends Error {
  constructor(envId: string) {
    super(`Mac offline: ${envId} has no live link to this host`)
    this.name = 'PeerOfflineError'
  }
}

export class PeerCalls {
  private readonly registered = new Map<string, Registration>()
  private readonly calls = new Map<string, PendingCall>()

  constructor(
    readonly environmentId: string,
    private readonly log: (line: string) => void = (line) => console.log(`[peer-calls] ${line}`)
  ) {}

  /** peer.register: the latest socket under an environment id wins. */
  register(
    socket: PeerSocket,
    params: { from: string; offers: string[]; home?: string }
  ): { environmentId: string } {
    const prior = this.registered.get(params.from)
    this.registered.set(params.from, {
      socket,
      offers: new Set(params.offers),
      ...(params.home ? { home: params.home } : {}),
      at: Date.now()
    })
    if (prior?.socket.connection !== socket.connection)
      this.log(
        `${params.from} registered (offers ${params.offers.join(',') || 'none'}, key ${socket.keyId ?? 'local'})`
      )
    return { environmentId: this.environmentId }
  }

  /** The socket closed: its registrations go, and every call still out on it fails now. */
  drop(connection: number): void {
    for (const [envId, reg] of this.registered) {
      if (reg.socket.connection !== connection) continue
      this.registered.delete(envId)
      this.log(`${envId} went offline`)
    }
    for (const [callId, call] of this.calls) {
      if (call.connection !== connection) continue
      this.settle(callId, call, new PeerOfflineError(call.envId))
    }
  }

  online(envId: string, offer?: string): boolean {
    const reg = this.registered.get(envId)
    return !!reg && (!offer || reg.offers.has(offer))
  }

  /** The home directory a registered peer named, while it is registered. */
  homeOf(envId: string): string | null {
    return this.registered.get(envId)?.home ?? null
  }

  registeredIds(offer?: string): string[] {
    return [...this.registered.entries()]
      .filter(([, r]) => !offer || r.offers.has(offer))
      .map(([id]) => id)
  }

  pendingCount(): number {
    return this.calls.size
  }

  /** Ask a registered peer; rejects with PeerOfflineError when none, or on the deadline. */
  call<T = unknown>(
    envId: string,
    method: MacPeerMethod,
    params: Extract<MacBridgePush, { push: 'peer.call' }>['params'],
    deadlineMs: number,
    opts: { onProgress?: (frame: ProgressFrame) => void } = {}
  ): Promise<T> {
    const reg = this.registered.get(envId)
    if (!reg) return Promise.reject(new PeerOfflineError(envId))
    const callId = `c${randomBytes(9).toString('base64url')}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.calls.get(callId)
        if (call)
          this.settle(
            callId,
            call,
            new Error(`the Mac did not answer ${method} within ${Math.round(deadlineMs / 1000)} s`)
          )
      }, deadlineMs)
      timer.unref()
      this.calls.set(callId, {
        envId,
        method,
        connection: reg.socket.connection,
        chunks: [],
        ...(opts.onProgress ? { progress: new ProgressOrder(opts.onProgress) } : {}),
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      reg.socket.send({ push: 'peer.call', callId, method, params, deadlineMs })
    })
  }

  private settle(callId: string, call: PendingCall, outcome: Error | { value: unknown }): void {
    this.calls.delete(callId)
    clearTimeout(call.timer)
    if (outcome instanceof Error) call.reject(outcome)
    else call.resolve(outcome.value)
  }

  /** The call a frame names, only when it came from the socket the call went out on. */
  private own(connection: number, callId: string): PendingCall {
    const call = this.calls.get(callId)
    if (!call || call.connection !== connection) throw new Error('unknown or expired call')
    return call
  }

  chunk(connection: number, params: { callId: string; index: number; data: string }): { ok: true } {
    const call = this.own(connection, params.callId)
    if (params.index >= PEER_MAX_CHUNKS) throw new Error('too many chunks')
    call.chunks[params.index] = params.data
    return { ok: true }
  }

  reply(
    connection: number,
    params: { callId: string; ok: boolean; result?: unknown; error?: string; chunks?: number }
  ): { ok: true } {
    const call = this.own(connection, params.callId)
    if (!params.ok) {
      this.settle(
        params.callId,
        call,
        new Error(params.error || `${call.method} failed on the Mac`)
      )
      return { ok: true }
    }
    if (params.chunks === undefined) {
      this.settle(params.callId, call, { value: params.result ?? null })
      return { ok: true }
    }
    const parts = call.chunks.slice(0, params.chunks)
    if (
      parts.length !== params.chunks ||
      parts.some((p) => p === undefined) ||
      call.chunks.length > params.chunks
    ) {
      this.settle(params.callId, call, new Error(`${call.method}: the reply arrived incomplete`))
      return { ok: true }
    }
    try {
      this.settle(params.callId, call, { value: JSON.parse(parts.join('')) })
    } catch {
      this.settle(params.callId, call, new Error(`${call.method}: the reply did not parse`))
    }
    return { ok: true }
  }

  /**
   * peer.progress: a running call's output so far. A frame for a call that
   * already settled (or never was) is dropped quietly, since the reply can
   * overtake nothing but a late frame can follow it; a frame for a live call
   * from any socket but the one the call went out on is refused.
   */
  progress(
    connection: number,
    params: { callId: string; seq: number; chunk: string; skipped?: number }
  ): { ok: true } {
    const call = this.calls.get(params.callId)
    if (!call) return { ok: true }
    if (call.connection !== connection)
      throw new Error('forbidden: progress for a call this socket does not carry')
    call.progress?.take({ seq: params.seq, chunk: params.chunk, skipped: params.skipped ?? 0 })
    return { ok: true }
  }

  /** Every pending call fails; registrations go. */
  close(): void {
    for (const [callId, call] of this.calls) this.settle(callId, call, new Error('server closing'))
    this.registered.clear()
  }

  /** The connection a peer registered on, for a stage only that socket may pull (macWriteStage.ts). */
  connectionOf(envId: string): number | null {
    return this.registered.get(envId)?.socket.connection ?? null
  }
}

/** The peer.* requests on the box. Remote principals only: the box's own loopback never registers as a Mac. */
export function handlePeerRequest(
  calls: PeerCalls,
  socket: PeerSocket & { remote: boolean },
  req:
    | { method: 'peer.register'; params: { from: string; offers: string[]; home?: string } }
    | {
        method: 'peer.reply'
        params: { callId: string; ok: boolean; result?: unknown; error?: string; chunks?: number }
      }
    | { method: 'peer.chunk'; params: { callId: string; index: number; data: string } }
    | {
        method: 'peer.progress'
        params: { callId: string; seq: number; chunk: string; skipped?: number }
      }
): unknown {
  if (!socket.remote) throw new Error(`forbidden: ${req.method} is for another host's main process`)
  switch (req.method) {
    case 'peer.register':
      return calls.register(socket, req.params)
    case 'peer.reply':
      return calls.reply(socket.connection, req.params)
    case 'peer.chunk':
      return calls.chunk(socket.connection, req.params)
    case 'peer.progress':
      return calls.progress(socket.connection, req.params)
  }
}

// ── the Mac side: answering a call over PeerLink.request ─────────────

export type LinkRequest = (
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number }
) => Promise<unknown>

/** Send one call's outcome; a result whose JSON passes PEER_CHUNK_CHARS goes as chunks first. */
export async function replyOverLink(
  request: LinkRequest,
  callId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: string },
  chunkChars: number = PEER_CHUNK_CHARS
): Promise<void> {
  if (!outcome.ok) {
    await request('peer.reply', { callId, ok: false, error: outcome.error.slice(0, 4_000) })
    return
  }
  const json = JSON.stringify(outcome.result ?? null)
  if (json.length <= chunkChars) {
    await request('peer.reply', { callId, ok: true, result: outcome.result ?? null })
    return
  }
  const chunks = Math.ceil(json.length / chunkChars)
  if (chunks > PEER_MAX_CHUNKS) {
    await request('peer.reply', {
      callId,
      ok: false,
      error: `the answer is too large to send (${json.length} characters)`
    })
    return
  }
  // One frame at a time, each acknowledged: the socket never holds more than one chunk.
  for (let i = 0; i < chunks; i++)
    await request(
      'peer.chunk',
      { callId, index: i, data: json.slice(i * chunkChars, (i + 1) * chunkChars) },
      { timeoutMs: 120_000 }
    )
  await request('peer.reply', { callId, ok: true, chunks })
}

export type PeerCallHandler = (
  method: MacPeerMethod,
  params: Extract<MacBridgePush, { push: 'peer.call' }>['params'],
  ctx: {
    from: string
    callId: string
    deadlineAt: number
    /** Send output so far as a peer.progress frame (peerStreams.ts progressSender). */
    progress?: (chunk: string, skipped?: number) => void
  }
) => Promise<unknown>

/** Run one peer.call push through `handler` and reply; a reply the box refuses (expired) is logged and dropped. */
export async function servePeerCall(
  push: Extract<MacBridgePush, { push: 'peer.call' }>,
  from: string,
  handler: PeerCallHandler,
  request: LinkRequest,
  log: (line: string) => void = () => {}
): Promise<void> {
  const deadlineAt = Date.now() + Math.max(0, push.deadlineMs)
  let outcome: { ok: true; result: unknown } | { ok: false; error: string }
  try {
    outcome = {
      ok: true,
      result: await handler(push.method, push.params, {
        from,
        callId: push.callId,
        deadlineAt,
        progress: progressSender(request, push.callId, log)
      })
    }
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    await replyOverLink(request, push.callId, outcome)
  } catch (err) {
    log(
      `${push.method} reply to ${from} not taken: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
