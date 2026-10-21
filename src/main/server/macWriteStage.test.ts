import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import { ClientRequestSchema } from '@shared/contract'
import {
  MacWriteFileArgsSchema,
  PEER_CHUNK_CHARS,
  type MacBridgePush
} from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import { MacThreadTokens, MacTools } from './macTools'
import {
  MacWriteStages,
  decodeBase64Strict,
  handlePeerPull,
  prepareMacWrite
} from './macWriteStage'
import { MacBridge } from './remote/macBridge'
import { PeerCalls, handlePeerRequest, servePeerCall } from './remote/peerCalls'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tc-macwrite-stage-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('decodeBase64Strict', () => {
  it('takes padded standard base64, refuses anything else', () => {
    expect(decodeBase64Strict('aGk=').toString()).toBe('hi')
    expect(decodeBase64Strict('').length).toBe(0)
    expect(() => decodeBase64Strict('aGk')).toThrow(/not valid base64/)
    expect(() => decodeBase64Strict('a-k=')).toThrow(/not valid base64/)
    expect(() => decodeBase64Strict('aG k=')).toThrow(/not valid base64/)
  })
})

describe('mac.writeFile: text or dataBase64, exactly one', () => {
  it('the zod schema takes either and refuses both or neither, for the tool args and the request', () => {
    expect(MacWriteFileArgsSchema.safeParse({ path: '/x', text: 'héllo' }).success).toBe(true)
    expect(MacWriteFileArgsSchema.safeParse({ path: '/x', text: '' }).success).toBe(true)
    expect(MacWriteFileArgsSchema.safeParse({ path: '/x', dataBase64: 'aGk=' }).success).toBe(true)
    const both = MacWriteFileArgsSchema.safeParse({ path: '/x', text: 'a', dataBase64: 'aGk=' })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0]?.message).toMatch(/exactly one/)
    expect(MacWriteFileArgsSchema.safeParse({ path: '/x' }).success).toBe(false)
    const req = (params: Record<string, unknown>): boolean =>
      ClientRequestSchema.safeParse({
        id: '1',
        method: 'mac.writeFile',
        params: { sessionId: 's', token: 't', path: '/x', ...params }
      }).success
    expect(req({ text: 'a' })).toBe(true)
    expect(req({ dataBase64: 'aGk=' })).toBe(true)
    expect(req({ text: 'a', dataBase64: 'aGk=' })).toBe(false)
    expect(req({})).toBe(false)
  })

  it('text is encoded as UTF-8 on the box: the wire carries base64 of its bytes, inline or staged', () => {
    const stages = new MacWriteStages()
    const small = prepareMacWrite({ path: '/x', text: 'héllo ✓\n' }, 1, stages)
    expect(small.wire.dataBase64).toBe(Buffer.from('héllo ✓\n', 'utf8').toString('base64'))
    expect(small.wire.size).toBe(Buffer.byteLength('héllo ✓\n', 'utf8'))
    expect(small.wire).not.toHaveProperty('text')
    const long = 'é'.repeat(200)
    const big = prepareMacWrite({ path: '/x', text: long }, 1, stages, 100)
    expect(big.wire.size).toBe(400)
    expect(big.wire.staged?.chunks).toBe(
      Math.ceil(Buffer.from(long).toString('base64').length / 100)
    )
    big.release()
    expect(() =>
      prepareMacWrite({ path: '/x', text: 'é'.repeat(4 * 1024 * 1024 + 1) }, 1, stages)
    ).toThrow(/too large/)
    expect(() => prepareMacWrite({ path: '/x', text: 'a', dataBase64: 'aGk=' }, 1, stages)).toThrow(
      /exactly one/
    )
  })
})

describe('MacWriteStages', () => {
  it('a stage answers only its own socket, piece by piece, until it is dropped', () => {
    const stages = new MacWriteStages()
    const { id, chunks } = stages.stage(7, 'abcdefghij', 4)
    expect(chunks).toBe(3)
    expect(stages.pull(7, { stageId: id, index: 0 })).toEqual({ data: 'abcd' })
    expect(stages.pull(7, { stageId: id, index: 2 })).toEqual({ data: 'ij' })
    expect(() => stages.pull(8, { stageId: id, index: 0 })).toThrow(/unknown or expired/)
    expect(() => stages.pull(7, { stageId: id, index: 3 })).toThrow(/no such piece/)
    expect(() =>
      handlePeerPull(stages, { connection: 7, remote: false }, { stageId: id, index: 0 })
    ).toThrow(/forbidden/)
    stages.drop(id)
    expect(() => stages.pull(7, { stageId: id, index: 0 })).toThrow(/unknown or expired/)
  })

  it('prepareMacWrite: inline under the frame size, staged above it, hashed, 8 MiB at most', () => {
    const stages = new MacWriteStages()
    const small = prepareMacWrite({ path: '/x', dataBase64: 'aGk=' }, 1, stages)
    expect(small.wire).toMatchObject({ path: '/x', mode: 'create', size: 2, dataBase64: 'aGk=' })
    expect(small.wire.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(stages.size()).toBe(0)
    const body = Buffer.alloc(300, 1).toString('base64')
    const big = prepareMacWrite({ path: '/x', dataBase64: body, mode: 'overwrite' }, 1, stages, 100)
    expect(big.wire.dataBase64).toBeUndefined()
    expect(big.wire.staged?.chunks).toBe(4)
    expect(stages.size()).toBe(1)
    big.release()
    expect(stages.size()).toBe(0)
    expect(() => prepareMacWrite({ path: '/x', dataBase64: body }, null, stages, 100)).toThrow(
      /Mac offline/
    )
    expect(() => prepareMacWrite({ path: '/x', dataBase64: 'aGk' }, 1, stages)).toThrow(/base64/)
    expect(() =>
      prepareMacWrite({ path: '/x', dataBase64: 'aGk=', fileMode: 0o4755 }, 1, stages)
    ).toThrow()
    expect(() =>
      prepareMacWrite(
        { path: '/x', dataBase64: Buffer.alloc(8 * 1024 * 1024 + 3).toString('base64') },
        1,
        stages
      )
    ).toThrow()
  })
})

const meta = (id: string): SessionMeta =>
  ({
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    title: `T ${id}`,
    status: 'idle',
    permission: 'safe'
  }) as SessionMeta

/** A box (MacTools + PeerCalls) and a Mac (MacBridge) joined by one in-memory peer link. */
function linked() {
  const home = join(dir, 'home')
  const shared = join(home, 'shared')
  mkdirSync(shared, { recursive: true })
  const calls = new PeerCalls('env_box', () => {})
  const stages = new MacWriteStages()
  const tokens = new MacThreadTokens('cd'.repeat(16))
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  // What the Mac's main process sends the box on its link (peer.reply / chunk / pull).
  const macRequest = async (method: string, params?: unknown): Promise<unknown> =>
    method === 'peer.pull'
      ? handlePeerPull(stages, socket, params as { stageId: string; index: number })
      : handlePeerRequest(calls, socket, { method, params } as Parameters<
          typeof handlePeerRequest
        >[2])
  const macSettings = new Map<string, string>()
  const mac = new MacBridge({
    environmentId: 'env_mac',
    store: {
      getSetting: (k) => macSettings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? macSettings.delete(k) : macSettings.set(k, v))
    },
    managedRoots: () => [],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => macRequest,
    home,
    log: () => {}
  })
  const socket = {
    connection: 1,
    keyId: 'k',
    remote: true,
    send: (frame: ServerFrame) => {
      if (!('push' in frame) || frame.push !== 'peer.call') return
      pushes.push(frame as MacBridgePush)
      void servePeerCall(
        frame as Extract<MacBridgePush, { push: 'peer.call' }>,
        'env_box',
        (method, params, ctx) => mac.handle(method, params, ctx),
        macRequest
      )
    }
  }
  handlePeerRequest(calls, socket, {
    method: 'peer.register',
    params: { from: 'env_mac', offers: ['mac-bridge'] }
  })
  const tools = new MacTools({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
    },
    sessions: { get: (id) => (id === 'root' || id === 'other' ? meta(id) : null) },
    landing: { getProject: () => null, getWorkspace: () => null },
    dataDir: join(dir, 'data'),
    calls,
    tokens,
    writeStages: stages,
    log: () => {}
  })
  tools.setThread('root', 'env_mac')
  mac.setPolicy('env_box', 'read+run')
  mac.setShared('env_box', [shared])
  return { tools, tokens, stages, pushes, shared, calls }
}

describe('mac.writeFile from a box thread', () => {
  it("the token gate: a wrong, missing or another thread's token is refused before anything is staged or sent", async () => {
    const { tools, tokens, stages, pushes, shared } = linked()
    const args = { path: join(shared, 'x.txt'), dataBase64: 'aGk=' }
    await expect(tools.call('root', 'nope', 'mac.writeFile', args)).rejects.toThrow(/own token/)
    await expect(tools.call('root', undefined, 'mac.writeFile', args)).rejects.toThrow(/own token/)
    await expect(
      tools.call('root', tokens.tokenFor('other'), 'mac.writeFile', args)
    ).rejects.toThrow(/own token/)
    await expect(
      tools.handle({
        id: '1',
        method: 'mac.writeFile',
        params: { ...args, sessionId: 'other', token: tokens.tokenFor('other') }
      })
    ).rejects.toThrow(/off for this thread/)
    expect(pushes).toEqual([])
    expect(stages.size()).toBe(0)
  })

  it('a small write rides inside the call and lands in the shared folder', async () => {
    const { tools, tokens, pushes, shared } = linked()
    const out = await tools.call('root', tokens.tokenFor('root'), 'mac.writeFile', {
      path: join(shared, 'small.txt'),
      dataBase64: Buffer.from('small body').toString('base64')
    })
    expect(out).toEqual({
      path: join(shared, 'small.txt'),
      bytes: 10,
      mode: 'create',
      created: true
    })
    expect(readFileSync(join(shared, 'small.txt'), 'utf8')).toBe('small body')
    const push = pushes[0] as Extract<MacBridgePush, { push: 'peer.call' }>
    expect(push.method).toBe('mac.writeFile')
    expect(push.deadlineMs).toBe(10 * 60_000 + 120_000 + 30_000)
  })

  it('a text write lands as its UTF-8 bytes, small or staged', async () => {
    const { tools, tokens, stages, shared } = linked()
    const out = await tools.call('root', tokens.tokenFor('root'), 'mac.writeFile', {
      path: join(shared, 'note.md'),
      text: '# Héllo\n✓ from the box\n'
    })
    expect(out).toMatchObject({ bytes: Buffer.byteLength('# Héllo\n✓ from the box\n') })
    expect(readFileSync(join(shared, 'note.md'), 'utf8')).toBe('# Héllo\n✓ from the box\n')
    const long = 'line ✓\n'.repeat(400_000)
    await tools.call('root', tokens.tokenFor('root'), 'mac.writeFile', {
      path: join(shared, 'long.txt'),
      text: long
    })
    expect(readFileSync(join(shared, 'long.txt'), 'utf8')).toBe(long)
    expect(stages.size()).toBe(0)
  })

  it('a write past the frame size is staged, pulled by the Mac, and the stage is gone after', async () => {
    const { tools, tokens, stages, pushes, shared } = linked()
    const body = Buffer.alloc(PEER_CHUNK_CHARS + 12_345)
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff
    const out = await tools.call('root', tokens.tokenFor('root'), 'mac.writeFile', {
      path: join(shared, 'big.bin'),
      dataBase64: body.toString('base64'),
      mode: 'overwrite'
    })
    expect(out).toMatchObject({ bytes: body.length, mode: 'overwrite' })
    expect(readFileSync(join(shared, 'big.bin')).equals(body)).toBe(true)
    const push = pushes[0] as Extract<MacBridgePush, { push: 'peer.call' }>
    const sent = push.params.args as { dataBase64?: string; staged?: { chunks: number } }
    expect(sent.dataBase64).toBeUndefined()
    expect(sent.staged?.chunks).toBe(2)
    expect(JSON.stringify(push).length).toBeLessThan(1_000)
    expect(stages.size()).toBe(0)
  })
})
