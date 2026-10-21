import { createHash, randomBytes } from 'node:crypto'
import {
  MAC_APPROVAL_WAIT_MS,
  MAC_WRITE_MAX_BYTES,
  MacWriteFileArgsSchema,
  PEER_CHUNK_CHARS,
  PEER_MAX_CHUNKS,
  type MacCallThread,
  type MacWriteFileResult,
  type MacWriteFileWire
} from '@shared/contract-macbridge'
import type { PeerCalls } from './remote/peerCalls'

/**
 * The box side of mac.writeFile (docs/box.md "The Mac bridge"). A thread's
 * bytes go to the Mac inside the `peer.call` when their base64 fits one
 * PEER_CHUNK_CHARS frame; a longer write is staged here and the Mac pulls it
 * piece by piece with `peer.pull` (admin, the peer link only), after the
 * person at the Mac allowed it, so nothing large crosses for a write that is
 * denied. A stage answers only the socket its call went out on, and it is
 * dropped the moment the call settles.
 */

/** How long the Mac may spend pulling a staged write, on top of the approval wait. */
export const MAC_WRITE_PULL_MS = 120_000
const DEADLINE_SLACK_MS = 30_000

/** A base64 string the Mac will decode to exactly these bytes: the standard alphabet, padded. */
export function decodeBase64Strict(b64: string): Buffer {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64))
    throw new Error('dataBase64 is not valid base64')
  return Buffer.from(b64, 'base64')
}

interface Stage {
  connection: number
  chunks: string[]
}

export class MacWriteStages {
  private readonly stages = new Map<string, Stage>()

  /** Hold a write's base64 for the Mac on `connection` to pull, in pieces of `chunkChars`. */
  stage(
    connection: number,
    b64: string,
    chunkChars: number = PEER_CHUNK_CHARS
  ): { id: string; chunks: number } {
    const chunks: string[] = []
    for (let i = 0; i < b64.length; i += chunkChars) chunks.push(b64.slice(i, i + chunkChars))
    if (chunks.length > PEER_MAX_CHUNKS) throw new Error('too large to send to the Mac')
    const id = `st${randomBytes(9).toString('base64url')}`
    this.stages.set(id, { connection, chunks })
    return { id, chunks: chunks.length }
  }

  /** peer.pull: one piece, only for the socket the call went out on. */
  pull(connection: number, params: { stageId: string; index: number }): { data: string } {
    const stage = this.stages.get(params.stageId)
    if (!stage || stage.connection !== connection) throw new Error('unknown or expired stage')
    const data = stage.chunks[params.index]
    if (data === undefined) throw new Error('no such piece')
    return { data }
  }

  drop(id: string): void {
    this.stages.delete(id)
  }

  size(): number {
    return this.stages.size
  }
}

/** The box's one set of stages (index.ts answers peer.pull from it). */
export const macWriteStages = new MacWriteStages()

/** The peer.pull request on the box: remote principals only, like the other peer.* methods. */
export function handlePeerPull(
  stages: MacWriteStages,
  socket: { connection: number; remote: boolean },
  params: { stageId: string; index: number }
): { data: string } {
  if (!socket.remote) throw new Error("forbidden: peer.pull is for another host's main process")
  return stages.pull(socket.connection, params)
}

/** The wire args for one write: checked, hashed, inline or staged. `release` drops the stage. */
export function prepareMacWrite(
  raw: Record<string, unknown>,
  connection: number | null,
  stages: MacWriteStages,
  chunkChars: number = PEER_CHUNK_CHARS
): { wire: MacWriteFileWire; release: () => void } {
  const args = MacWriteFileArgsSchema.parse(raw)
  // text is encoded here, before staging: the Mac only ever sees base64 of the bytes.
  const data =
    args.text !== undefined
      ? Buffer.from(args.text, 'utf8')
      : decodeBase64Strict(args.dataBase64 ?? '')
  const b64 = args.text !== undefined ? data.toString('base64') : (args.dataBase64 ?? '')
  if (data.length > MAC_WRITE_MAX_BYTES)
    throw new Error(
      `too large to write: ${data.length} bytes (the limit is ${MAC_WRITE_MAX_BYTES})`
    )
  const base = {
    path: args.path,
    mode: args.mode ?? 'create',
    ...(args.fileMode !== undefined ? { fileMode: args.fileMode } : {}),
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex')
  } as const
  if (b64.length <= chunkChars) return { wire: { ...base, dataBase64: b64 }, release: () => {} }
  if (connection === null) throw new Error('Mac offline: no live link to stage the write on')
  const staged = stages.stage(connection, b64, chunkChars)
  return { wire: { ...base, staged }, release: () => stages.drop(staged.id) }
}

/** One mac.writeFile from a thread, after MacTools.call checked its token, switch and link. */
export async function callMacWrite(
  calls: PeerCalls,
  stages: MacWriteStages,
  macPeer: string,
  thread: MacCallThread,
  args: Record<string, unknown>,
  /** The peer call's id, named ahead so a pause can cancel it on the Mac (macPause.ts). */
  callId?: string
): Promise<MacWriteFileResult> {
  const { wire, release } = prepareMacWrite(args, calls.connectionOf(macPeer), stages)
  try {
    return await calls.call<MacWriteFileResult>(
      macPeer,
      'mac.writeFile',
      { thread, args: wire },
      MAC_APPROVAL_WAIT_MS + MAC_WRITE_PULL_MS + DEADLINE_SLACK_MS,
      callId ? { callId } : {}
    )
  } finally {
    release()
  }
}
