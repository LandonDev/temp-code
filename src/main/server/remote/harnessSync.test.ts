import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { HARNESS_CHUNK_BYTES } from '@shared/contract-harness'
import { requiredCapability } from '@shared/capabilities'
import { HarnessSync, handleHarness, PATH_MAP_KEY, stripHostBoundEnv } from './harnessSync'
import { setLagForTests } from '../stalls'
import { HARNESS_SET_LABELS } from '@shared/harnessSets'
import { HARNESS_SET, RETIRED_ROOTS, SKILL_BINARY_CACHE, buildManifest, commandExecutable, inSet, isMachO, isRetired, isSecretPath, missingHookExecutables, ruleFor, ruleRoot, setCounts, validRelPath, type SetRule } from './harnessSet'

/** A Mach-O header: the 64-bit little-endian magic the Mac's arm64 binaries carry, then anything. */
const machO = (body = 'engine'): Buffer => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]), Buffer.from(body)])

let root: string
let mac: string
let box: string
let work: string
const put = (home: string, rel: string, body: string | Buffer, mode?: number): void => {
  mkdirSync(dirname(join(home, rel)), { recursive: true })
  writeFileSync(join(home, rel), body)
  if (mode !== undefined) chmodSync(join(home, rel), mode)
}
const read = (home: string, rel: string): string => readFileSync(join(home, rel), 'utf8')
const has = (home: string, rel: string): boolean => existsSync(join(home, rel))

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-harness-')))
  mac = join(root, 'mac-home')
  box = join(root, 'box-home')
  work = join(root, 'work')
  for (const d of [mac, box, work]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const store = () => {
  const rows: Record<string, string> = {}
  return {
    rows,
    getSetting: (key: string) => rows[key] ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) delete rows[key]
      else rows[key] = value
    }
  }
}

/**
 * The Mac's HarnessSync and the box's, joined by a link that round-trips
 * every request through JSON and the contract's schema (what the socket
 * does) before the box's dispatch answers it.
 */
function pair(opts: { rules?: readonly SetRule[]; macEnabled?: boolean } = {}) {
  const boxLog: string[] = []
  const macLog: string[] = []
  const sent: { method: string; params: unknown }[] = []
  const boxStore = store()
  const receiver = new HarnessSync({
    environmentId: 'env_box',
    store: boxStore,
    peers: { get: () => undefined, all: () => [] },
    dataDir: join(root, 'box-data'),
    defaultEnabled: false,
    home: () => box,
    workRoot: () => work,
    rules: opts.rules,
    log: (l) => boxLog.push(l),
    pathEnv: () => '/usr/bin:/bin'
  })
  let seq = 0
  const link = {
    id: 'env_box',
    env: { name: 'box' },
    connected: true,
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      sent.push({ method, params })
      const req = ClientRequestSchema.parse(JSON.parse(JSON.stringify({ id: `r${++seq}`, method, params })))
      expect(requiredCapability(req)).toBe('admin')
      const out = await handleHarness(req, receiver)
      if (!out.handled) throw new Error(`unhandled ${method}`)
      return JSON.parse(JSON.stringify(out.result ?? null)) as T
    }
  }
  const macStore = store()
  const sender = new HarnessSync({
    environmentId: 'env_mac',
    store: macStore,
    peers: { get: (id: string) => (id === 'env_box' ? (link as never) : undefined), all: () => [link as never] },
    dataDir: join(root, 'mac-data'),
    defaultEnabled: opts.macEnabled ?? true,
    home: () => mac,
    rules: opts.rules,
    log: (l) => macLog.push(l)
  })
  return { sender, receiver, link, sent, boxLog, macLog, boxStore, macStore, methods: () => sent.map((s) => s.method) }
}

describe('the sync set', () => {
  it('covers commands, agents, hooks, settings, plugins, codex prompts/config/hooks and Muse settings/hooks; no skill folder and nothing else', () => {
    for (const rel of [
      '.claude/commands/x.md',
      '.claude/agents/y.md',
      '.claude/hooks/lint.sh',
      '.claude/settings.json',
      '.claude/plugins/installed_plugins.json',
      '.claude/plugins/cache/mkt/p/1.0/plugin.json',
      '.codex/prompts/p.md',
      '.codex/config.toml',
      '.codex/hooks.json',
      '.config/muse/settings.json',
      '.config/muse/hooks/pre.sh'
    ])
      expect(inSet(rel), rel).toBe(true)
    for (const rel of [
      // Skills are the store's now: every skill root is retired.
      '.claude/skills/a/SKILL.md',
      '.codex/skills/s/SKILL.md',
      '.agents/skills/z/SKILL.md',
      '.agents/skills/impeccable/scripts/impeccable',
      '.config/muse/skills/review/SKILL.md',
      '.claude/skills/synced/b/SKILL.md',
      '.agents/skills/impeccable/scripts/bin/darwin-arm64/impeccable',
      '.claude/skills/impeccable/scripts/bin/darwin-arm64/impeccable',
      '.codex/skills/impeccable/scripts/bin/linux-x64/impeccable',
      '.codex/hooks.json.bak',
      '.codex/memories_1.sqlite',
      '.claude/plugins/synced/x.json',
      '.claude/plugins/plugin-directory-cache-v2.json',
      '.codex/skills/.system/s/SKILL.md',
      '.claude/settings.local.json',
      '.claude/.credentials.json',
      '.codex/auth.json',
      '.claude.json',
      '.claude/projects/p/x.jsonl',
      '.codex/sessions/a.jsonl',
      '.codex/state_5.sqlite',
      '.claude/plugins/marketplaces/m/.git/HEAD',
      '.claude/commands/a/.DS_Store',
      '.claude/commands/a/server.pem',
      '.claude/commands/a/id.key'
    ])
      expect(inSet(rel), rel).toBe(false)
    for (const root of RETIRED_ROOTS) {
      expect(HARNESS_SET.some((r) => ruleRoot(r) === root || ruleRoot(r).startsWith(root + '/')), root).toBe(false)
      expect(isRetired(`${root}/x/SKILL.md`)).toBe(true)
    }
    expect(isRetired('.claude/commands/x.md')).toBe(false)
    // The renderer's list of labels is the set's, in its order.
    expect(HARNESS_SET.map((r) => r.label)).toEqual([...HARNESS_SET_LABELS])
  })

  it('refuses a path that is not a clean relative posix path', () => {
    for (const rel of ['../x', '.claude/../.ssh/id', '/etc/passwd', './.claude/settings.json', '.claude//x', '.claude\\x', 'a/./b', '']) expect(validRelPath(rel), rel).toBe(false)
    expect(ruleFor('.claude/commands/../../.ssh/id')).toBeNull()
  })

  it('every rule has a label, and setCounts files each manifest entry under its label', () => {
    for (const rule of HARNESS_SET) expect(rule.label.length, JSON.stringify(rule)).toBeGreaterThan(0)
    expect(new Set(HARNESS_SET.map((r) => r.label)).size).toBe(HARNESS_SET.length)
    const counts = setCounts([{ relPath: '.claude/commands/a.md' }, { relPath: '.claude/commands/b.md' }, { relPath: '.codex/hooks.json' }, { relPath: '.agents/skills/z/SKILL.md' }, { relPath: 'not/in/set' }])
    expect(counts).toMatchObject({ 'Claude commands': 2, 'Codex hooks': 1, 'Claude agents': 0 })
    expect(Object.keys(counts)).toEqual(HARNESS_SET.map((r) => r.label))
  })

  it('tells a Mach-O header from everything else, a universal binary from a Java class file', async () => {
    expect(isMachO(machO())).toBe(true)
    expect(isMachO(Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 12]))).toBe(true)
    expect(isMachO(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 12]))).toBe(true)
    expect(isMachO(Buffer.from([0xce, 0xfa, 0xed, 0xfe, 12, 0, 0, 0]))).toBe(true)
    expect(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 1, 2, 3, 4]))).toBe(true)
    expect(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65, 1, 2, 3, 4])), 'a Java class file, major version 65').toBe(false)
    expect(isMachO(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), 'ELF').toBe(false)
    expect(isMachO(Buffer.from('#!/bin/sh\nexec engine'))).toBe(false)
    expect(isMachO(Buffer.from([0xcf, 0xfa]))).toBe(false)
    expect(SKILL_BINARY_CACHE.test('impeccable/scripts/bin/darwin-arm64/impeccable')).toBe(true)
    expect(SKILL_BINARY_CACHE.test('impeccable/scripts/impeccable')).toBe(false)
  })

  it('never lets a secret in, even when the globs are widened to whole dirs', async () => {
    const wide: SetRule[] = [{ kind: 'tree', root: '.claude', label: 'c' }, { kind: 'tree', root: '.codex', label: 'x' }, { kind: 'tree', root: '.ssh', label: 's' }]
    for (const rel of ['.claude/.credentials.json', '.claude/settings.local.json', '.codex/auth.json', '.ssh/id.key', '.ssh/server.pem', '.claude/x/apns.p8']) {
      expect(isSecretPath(rel), rel).toBe(true)
      expect(inSet(rel, wide), rel).toBe(false)
    }
    put(mac, '.claude/.credentials.json', '{"claudeAiOauth":{}}')
    put(mac, '.claude/settings.local.json', '{}')
    put(mac, '.claude/settings.json', '{}')
    put(mac, '.codex/auth.json', '{}')
    put(mac, '.ssh/deploy.key', 'k')
    put(mac, '.ssh/cert.pem', 'p')
    put(mac, '.ssh/known_hosts', 'h')
    const rels = (await buildManifest(mac, { rules: wide })).entries.map((e) => e.relPath)
    expect(rels).toContain('.claude/settings.json')
    expect(rels).toContain('.ssh/known_hosts')
    for (const secret of ['.claude/.credentials.json', '.claude/settings.local.json', '.codex/auth.json', '.ssh/deploy.key', '.ssh/cert.pem']) expect(rels).not.toContain(secret)
  })
})

describe('the manifest', () => {
  it('lists the set with size, hash, mode and mtime; follows a symlink inside HOME, skips one out of reach, a .git dir and an oversize file', async () => {
    put(mac, '.claude/commands/a/x.md', '# a')
    put(mac, '.claude/commands/a/run.sh', '#!/bin/sh\n', 0o755)
    put(mac, 'IdeaProjects/repo/commands/linked/y.md', '# linked')
    symlinkSync(join(mac, 'IdeaProjects/repo/commands/linked'), join(mac, '.claude/commands/linked'))
    put(mac, '.ssh/id_ed25519', 'private')
    symlinkSync(join(mac, '.ssh'), join(mac, '.claude/commands/ssh'))
    put(root, 'outside/z.md', 'outside')
    symlinkSync(join(root, 'outside'), join(mac, '.claude/commands/outside'))
    put(mac, '.claude/plugins/marketplaces/m/.git/objects/pack/p.pack', 'x')
    put(mac, '.claude/plugins/marketplaces/m/README.md', 'r')
    put(mac, '.claude/plugins/plugin-directory-cache-v2.json', '{}')
    put(mac, '.claude/plugins/cache/m/p/1.0/big.bin', randomBytes(2048))
    put(mac, '.claude/commands/a/engine', machO(), 0o755)
    // A skill folder is walked no more: the store carries skills.
    put(mac, '.claude/skills/s/SKILL.md', '# s')
    put(mac, '.agents/skills/t/SKILL.md', '# t')
    const cache = new Map()
    const m = await buildManifest(mac, { maxBytes: 1024, cache })
    const rels = m.entries.map((e) => e.relPath)
    expect(rels).toEqual(['.claude/commands/a/run.sh', '.claude/commands/a/x.md', '.claude/commands/linked/y.md', '.claude/plugins/marketplaces/m/README.md'])
    expect(m.entries.find((e) => e.relPath.endsWith('run.sh'))?.mode).toBe(0o755)
    expect(m.skipped.map((s) => `${s.relPath}:${s.reason}`).sort()).toEqual([
      '.claude/commands/a/engine:native-binary',
      '.claude/commands/outside:symlink-out-of-reach',
      '.claude/commands/ssh:symlink-out-of-reach',
      '.claude/plugins/cache/m/p/1.0/big.bin:too-large'
    ])
    // the Mach-O verdict is cached with the hash: the next manifest does not read it again, and still leaves it out
    expect(cache.get(realpathSync(join(mac, '.claude/commands/a/engine')))?.native).toBe(true)
    unlinkSync(join(mac, '.claude/commands/a/engine'))
    put(mac, '.claude/commands/a/engine', 'now a script')
    const again = await buildManifest(mac, { maxBytes: 1024, cache })
    expect(again.entries.map((e) => e.relPath)).toContain('.claude/commands/a/engine')
  })

  it('walks a dir that is a symlink as a dir: into another rule root, or a package cache under HOME', async () => {
    put(mac, '.claude/commands/team/review.md', '# review')
    put(mac, '.claude/commands/team/run.sh', '#!/bin/sh\nexec review "$@"\n', 0o755)
    mkdirSync(join(mac, '.claude/agents'), { recursive: true })
    symlinkSync(join('..', 'commands', 'team'), join(mac, '.claude/agents/team'))
    put(mac, 'Library/Caches/pkg/prompts/cached/p.md', '# cached')
    mkdirSync(join(mac, '.codex/prompts'), { recursive: true })
    symlinkSync(join(mac, 'Library/Caches/pkg/prompts/cached'), join(mac, '.codex/prompts/cached'))
    const m = await buildManifest(mac)
    expect(m.entries.map((e) => e.relPath)).toEqual([
      '.claude/agents/team/review.md',
      '.claude/agents/team/run.sh',
      '.claude/commands/team/review.md',
      '.claude/commands/team/run.sh',
      '.codex/prompts/cached/p.md'
    ])
    expect(m.skipped).toEqual([])
    // the script is listed executable, under both roots, with the same hash
    const scripts = m.entries.filter((e) => e.relPath.endsWith('team/run.sh'))
    expect(scripts.map((e) => e.mode)).toEqual([0o755, 0o755])
    expect(scripts[0].sha256).toBe(scripts[1].sha256)
  })

  it('waits for a quiet loop before each directory it walks, and a busy loop only delays it', async () => {
    put(mac, '.claude/commands/a/x.md', 'a')
    put(mac, '.claude/commands/a/scripts/run.sh', 'r')
    put(mac, '.claude/commands/b/y.md', 'b')
    put(mac, '.claude/agents/c.md', 'c')
    const dirs: number[] = []
    const between = async (): Promise<void> => void dirs.push(dirs.length)
    const m = await buildManifest(mac, { between })
    expect(m.entries.map((e) => e.relPath)).toEqual(['.claude/agents/c.md', '.claude/commands/a/scripts/run.sh', '.claude/commands/a/x.md', '.claude/commands/b/y.md'])
    // commands, a, a/scripts, b, agents
    expect(dirs).toHaveLength(5)
    // The default wait is the loop's own: a busy loop holds the walk until it is quiet or the bound passes.
    setLagForTests({ meanMs: 120, maxMs: 300, ewmaMs: 120 })
    let done = false
    const walk = buildManifest(mac).then((r) => ((done = true), r))
    await new Promise((r) => setTimeout(r, 150))
    expect(done).toBe(false)
    setLagForTests(null)
    expect((await walk).entries).toHaveLength(4)
  })

  it('carries only enabledPlugins and mcpServers of ~/.claude.json', async () => {
    put(mac, '.claude.json', JSON.stringify({ oauthAccount: { email: 'x' }, projects: {}, enabledPlugins: { 'a@m': true }, mcpServers: { s: { command: 'x' } } }))
    expect((await buildManifest(mac)).claudeJson).toEqual({ enabledPlugins: { 'a@m': true }, mcpServers: { s: { command: 'x' } } })
    put(mac, '.claude.json', '{"half')
    expect((await buildManifest(mac)).claudeJson).toBeUndefined()
  })
})

describe('mac → box', () => {
  const seed = (): void => {
    put(mac, '.claude/settings.json', JSON.stringify({ statusLine: { command: `${mac}/.claude/statusline.sh` }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'tc-no-such-tool -e beep' }, { type: 'command', command: '/bin/sh -c true' }] }] } }))
    put(mac, '.claude/commands/deploy/run.md', `Run ${mac}/IdeaProjects/shop/bin/deploy and ${mac}/Desktop/Websites/site/x, see /Users/landon/IdeaProjects/temp-code/CLAUDE.md`)
    put(mac, '.claude/commands/deploy/go.sh', `#!/bin/sh\ncd ${mac}/IdeaProjects/shop\n`, 0o755)
    put(mac, '.claude/commands/deploy/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x2f, 0x55]))
    // Skill folders stay where they are: the store carries skills now.
    put(mac, '.claude/skills/tidy/SKILL.md', 'tidy')
    put(mac, '.claude/commands/ship.md', 'ship it')
    put(mac, '.claude/agents/rev.md', 'review')
    put(mac, '.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'p@m': [{ installPath: `${mac}/.claude/plugins/cache/m/p/1.0` }] } }))
    put(mac, '.claude/plugins/cache/m/p/1.0/plugin.json', '{}')
    put(mac, '.codex/config.toml', `model = "gpt"\n[projects."${mac}/IdeaProjects/shop"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n[hooks.state."${mac}/.codex/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:84ec1c77"\n`)
    put(mac, '.codex/prompts/p.md', 'prompt')
    put(mac, '.agents/skills/z/SKILL.md', 'z')
    put(mac, '.codex/hooks.json', JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '"$HOME/.agents/skills/z/scripts/z" hook', timeout: 5 }] }] } }))
    put(mac, '.claude/hooks/lint.sh', `#!/bin/sh\n${mac}/IdeaProjects/shop/bin/lint\n`, 0o755)
    put(mac, '.claude/.credentials.json', '{"secret":1}')
    put(mac, '.codex/auth.json', '{"secret":1}')
    put(mac, '.claude/settings.local.json', '{"local":1}')
    put(mac, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'mac@x' }, projects: { a: 1 }, enabledPlugins: { 'p@m': true }, mcpServers: { fs: { command: `${mac}/bin/mcp-fs` } } }))
    // the box's own: its account bucket, its local settings, its sign-in
    put(box, '.claude/skills/synced/b/SKILL.md', 'box bucket')
    put(box, '.claude/settings.local.json', '{"boxLocal":1}')
    put(box, '.claude/.credentials.json', '{"box":1}')
    put(box, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'box@x' }, machineID: 'box' }))
  }

  it('drops env entries that point at the sender\'s loopback from settings.json and says so', async () => {
    seed()
    put(mac, '.claude/settings.json', JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/claude', HTTPS_PROXY: 'http://localhost:3128', KEEP_ME: 'https://example.com' } }))
    const { sender, boxLog } = pair()
    await sender.syncWith('env_box')
    expect(JSON.parse(read(box, '.claude/settings.json'))).toEqual({ model: 'opus', env: { KEEP_ME: 'https://example.com' } })
    expect(boxLog).toContain('settings.json: dropped env ANTHROPIC_BASE_URL, HTTPS_PROXY (a loopback address on the sender means nothing here)')
    expect(stripHostBoundEnv('{"env":{"ANTHROPIC_BASE_URL":"http://[::1]:1/x"}}')).toEqual({ text: '{}\n', dropped: ['ANTHROPIC_BASE_URL'] })
    expect(stripHostBoundEnv('not json')).toEqual({ text: 'not json', dropped: [] })
  })

  it('lands the set translated, binaries byte for byte, modes kept; secrets and the box\'s own files untouched', async () => {
    seed()
    const { sender, macStore, boxLog, methods } = pair()
    await sender.syncWith('env_box')
    expect(methods()[0]).toBe('harness.manifest')
    expect(methods().at(-1)).toBe('harness.commit')
    expect(read(box, '.claude/commands/deploy/run.md')).toBe(`Run ${work}/shop/bin/deploy and ${work}/site/x, see /srv/agents/work/temp-code/CLAUDE.md`)
    expect(read(box, '.claude/commands/deploy/go.sh')).toBe(`#!/bin/sh\ncd ${work}/shop\n`)
    expect(statSync(join(box, '.claude/commands/deploy/go.sh')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(box, '.claude/commands/deploy/logo.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x2f, 0x55]))).toBe(true)
    // No skill folder crosses.
    expect(has(box, '.claude/skills/tidy')).toBe(false)
    expect(has(box, '.agents/skills/z')).toBe(false)
    expect(JSON.parse(read(box, '.claude/settings.json')).statusLine.command).toBe(`${box}/.claude/statusline.sh`)
    expect(JSON.parse(read(box, '.claude/plugins/installed_plugins.json')).plugins['p@m'][0].installPath).toBe(`${box}/.claude/plugins/cache/m/p/1.0`)
    expect(read(box, '.codex/config.toml')).toContain(`[projects."${work}/shop"]`)
    for (const rel of ['.claude/commands/ship.md', '.claude/agents/rev.md', '.codex/prompts/p.md', '.claude/plugins/cache/m/p/1.0/plugin.json']) expect(has(box, rel), rel).toBe(true)
    // Codex's hooks: hooks.json lands byte for byte (it names $HOME), and its trust row in config.toml names the box's copy
    expect(read(box, '.codex/hooks.json')).toBe(read(mac, '.codex/hooks.json'))
    expect(read(box, '.codex/config.toml')).toContain(`[hooks.state."${box}/.codex/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:84ec1c77"`)
    expect(read(box, '.claude/hooks/lint.sh')).toBe(`#!/bin/sh\n${work}/shop/bin/lint\n`)
    expect(statSync(join(box, '.claude/hooks/lint.sh')).mode & 0o777).toBe(0o755)
    // secrets never crossed; the box's own are as they were
    expect(read(box, '.claude/.credentials.json')).toBe('{"box":1}')
    expect(read(box, '.claude/settings.local.json')).toBe('{"boxLocal":1}')
    expect(has(box, '.codex/auth.json')).toBe(false)
    expect(read(box, '.claude/skills/synced/b/SKILL.md')).toBe('box bucket')
    // ~/.claude.json: the two keys merged, translated; the box's identity kept; no other Mac key
    const cj = JSON.parse(read(box, '.claude.json'))
    expect(cj).toEqual({ oauthAccount: { emailAddress: 'box@x' }, machineID: 'box', enabledPlugins: { 'p@m': true }, mcpServers: { fs: { command: `${box}/bin/mcp-fs` } } })
    // the hook line names what cannot run here
    expect(boxLog).toContain('settings.json landed; hook commands not on this host\'s PATH: tc-no-such-tool')
    const status = sender.status()
    expect(status.environments[0]).toMatchObject({ id: 'env_box', connected: true, files: 12, error: null })
    expect(status.environments[0].sets).toEqual({
      'Claude commands': 4,
      'Claude agents': 1,
      'Claude hooks': 1,
      'Claude settings': 1,
      'Claude plugins': 2,
      'Codex prompts': 1,
      'Codex config': 1,
      'Codex hooks': 1,
      'Muse settings': 0,
      'Muse hooks': 0
    })
    expect(status.environments[0].syncedAt).toBeGreaterThan(0)
    expect(JSON.parse(macStore.rows['harness.sync.status']).env_box.files).toBe(12)
  })

  it('a dir that is a symlink lands as a real dir with the target\'s files', async () => {
    put(mac, '.claude/commands/team/review.md', '# review')
    put(mac, '.claude/commands/team/run.sh', '#!/bin/sh\nexec review "$@"\n', 0o755)
    mkdirSync(join(mac, '.claude/agents'), { recursive: true })
    symlinkSync(join('..', 'commands', 'team'), join(mac, '.claude/agents/team'))
    const { sender, boxLog } = pair()
    await sender.syncWith('env_box')
    for (const root of ['.claude/commands', '.claude/agents']) {
      expect(lstatSync(join(box, root, 'team')).isSymbolicLink(), root).toBe(false)
      expect(read(box, `${root}/team/review.md`)).toBe('# review')
      expect(statSync(join(box, root, 'team/run.sh')).mode & 0o777).toBe(0o755)
    }
    expect(boxLog.some((l) => l.includes('refused'))).toBe(false)
    expect(sender.status().environments[0].sets).toMatchObject({ 'Claude commands': 2, 'Claude agents': 2 })
  })

  it('a Mach-O file never crosses: left out of the manifest, and refused on landing when a manifest names one anyway', async () => {
    put(mac, '.claude/commands/tool/readme.md', '# tool')
    put(mac, '.claude/commands/tool/engine', machO(), 0o755)
    put(mac, '.claude/commands/tool/fat', Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]), randomBytes(64)]), 0o755)
    put(mac, '.claude/commands/tool/Main.class', Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 65]), randomBytes(64)]))
    const { sender, receiver, link, boxLog } = pair()
    await sender.syncWith('env_box')
    expect(has(box, '.claude/commands/tool/readme.md')).toBe(true)
    expect(has(box, '.claude/commands/tool/Main.class'), 'a class file is not a Mach-O').toBe(true)
    expect(has(box, '.claude/commands/tool/engine')).toBe(false)
    expect(has(box, '.claude/commands/tool/fat')).toBe(false)
    expect(sender.status().skipped).toBe(2)
    // a sender that lists one anyway: the receiver stages it and refuses it at commit, nothing lands
    const bytes = machO('smuggled')
    const entry = { relPath: '.claude/commands/tool/smuggled', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o755, mtime: Date.now() }
    const answer = await link.request<{ need: string[] }>('harness.manifest', { from: 'env_mac', home: mac, generation: 'g-macho', entries: [entry] })
    expect(answer.need).toContain(entry.relPath)
    await link.request('harness.file', { generation: 'g-macho', relPath: entry.relPath, chunkIndex: 0, chunks: 1, dataBase64: bytes.toString('base64') })
    const done = await link.request<{ written: number }>('harness.commit', { generation: 'g-macho' })
    expect(done.written).toBe(0)
    expect(has(box, '.claude/commands/tool/smuggled')).toBe(false)
    expect(boxLog).toContain('refused ".claude/commands/tool/smuggled" from env_mac: a macOS binary')
    expect(receiver.status().enabled).toBe(false)
  })

  it('sends only what changed, restores a file edited on the box, and mirrors a deletion without touching a file the box made itself', async () => {
    seed()
    const { sender, sent } = pair()
    await sender.syncWith('env_box')
    const files = (from: number) => sent.slice(from).filter((s) => s.method === 'harness.file').map((s) => (s.params as { relPath: string }).relPath)

    let mark = sent.length
    await sender.syncWith('env_box')
    expect(files(mark)).toEqual([])

    put(mac, '.claude/commands/ship.md', 'ship it now')
    put(box, '.claude/agents/rev.md', 'box edit')
    put(box, '.claude/commands/own.md', 'made on the box')
    mark = sent.length
    await sender.syncWith('env_box')
    expect(files(mark).sort()).toEqual(['.claude/agents/rev.md', '.claude/commands/ship.md'])
    expect(read(box, '.claude/commands/ship.md')).toBe('ship it now')
    expect(read(box, '.claude/agents/rev.md')).toBe('review')

    rmSync(join(mac, '.claude/commands/deploy'), { recursive: true })
    unlinkSync(join(mac, '.codex/prompts/p.md'))
    mark = sent.length
    await sender.syncWith('env_box')
    const answer = sent[mark]
    expect(answer.method).toBe('harness.manifest')
    expect(has(box, '.claude/commands/deploy')).toBe(false)
    expect(has(box, '.codex/prompts/p.md')).toBe(false)
    expect(has(box, '.codex/prompts')).toBe(true) // the rule root itself stays
    expect(read(box, '.claude/commands/own.md')).toBe('made on the box')
    expect(read(box, '.claude/skills/synced/b/SKILL.md')).toBe('box bucket')
  })

  it('drops a ~/.claude.json key the Mac no longer has, and only one a sync wrote', async () => {
    seed()
    const { sender } = pair()
    await sender.syncWith('env_box')
    put(mac, '.claude.json', JSON.stringify({ enabledPlugins: { 'p@m': false } }))
    await sender.syncWith('env_box')
    expect(JSON.parse(read(box, '.claude.json'))).toEqual({ oauthAccount: { emailAddress: 'box@x' }, machineID: 'box', enabledPlugins: { 'p@m': false } })
  })

  it('streams a big file in chunks of at most HARNESS_CHUNK_BYTES and lands it whole', async () => {
    const big = randomBytes(HARNESS_CHUNK_BYTES * 2 + 123)
    put(mac, '.claude/plugins/cache/m/p/1.0/bin/tool', big, 0o755)
    const { sender, sent } = pair()
    await sender.syncWith('env_box')
    const chunks = sent.filter((s) => s.method === 'harness.file').map((s) => s.params as { chunkIndex: number; chunks: number; dataBase64: string })
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2])
    expect(chunks.every((c) => c.chunks === 3 && Buffer.from(c.dataBase64, 'base64').length <= HARNESS_CHUNK_BYTES)).toBe(true)
    expect(readFileSync(join(box, '.claude/plugins/cache/m/p/1.0/bin/tool')).equals(big)).toBe(true)
  })

  it('re-lands translated files when the path map changes, and the pathMap setting maps a root', async () => {
    put(mac, '.claude/commands/a.md', `${mac}/Special/proj/run`)
    put(mac, '.claude/commands/b.bin', 'bytes')
    const { sender, receiver, sent } = pair()
    await sender.syncWith('env_box')
    expect(read(box, '.claude/commands/a.md')).toBe(`${box}/Special/proj/run`)
    receiver.setSettings({ pathMap: { roots: { [`${mac}/Special/proj`]: '/opt/proj' }, prefixes: {} } })
    const mark = sent.length
    await sender.syncWith('env_box')
    expect(sent.slice(mark).filter((s) => s.method === 'harness.file').map((s) => (s.params as { relPath: string }).relPath)).toEqual(['.claude/commands/a.md'])
    expect(read(box, '.claude/commands/a.md')).toBe('/opt/proj/run')
    expect(() => receiver.setSettings({ pathMap: { roots: { relative: '/x' } } })).toThrow(/absolute/)
  })

  it('a file that cannot land holds nothing else back; the status names it and the next sync retries it', async () => {
    put(mac, '.claude/commands/a.md', 'a')
    put(mac, '.claude/commands/b.md', 'b')
    mkdirSync(join(box, '.claude/commands/b.md/inside'), { recursive: true })
    const { sender } = pair()
    await sender.syncWith('env_box')
    expect(read(box, '.claude/commands/a.md')).toBe('a')
    expect(sender.status().environments[0].error).toMatch(/1 file\(s\) did not land here, first \.claude\/commands\/b\.md/)
    rmSync(join(box, '.claude/commands/b.md'), { recursive: true })
    await sender.syncWith('env_box')
    expect(read(box, '.claude/commands/b.md')).toBe('b')
    expect(sender.status().environments[0].error).toBeNull()
  })

  it('a watch event with nothing new sends nothing; sending off sends nothing at all', async () => {
    put(mac, '.claude/commands/a.md', 'a')
    const p = pair()
    await p.sender.syncWith('env_box', 'watch')
    const n = p.sent.length
    await p.sender.syncWith('env_box', 'watch')
    expect(p.sent.length).toBe(n)
    await p.sender.syncWith('env_box', 'periodic')
    expect(p.sent.length).toBe(n + 2) // manifest + commit, no files
    const off = pair({ macEnabled: false })
    await off.sender.syncWith('env_box')
    expect(off.sent).toEqual([])
  })
})

describe('the receiver', () => {
  const entry = (relPath: string, body: string) => ({ relPath, size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), mode: 0o644, mtime: Date.now() })
  const b64 = (s: string): string => Buffer.from(s).toString('base64')

  it('refuses paths outside the set, secrets, traversal and a landing through a symlink that points out; none of it is written', async () => {
    const { receiver, boxLog } = pair()
    mkdirSync(join(root, 'outside'))
    mkdirSync(join(box, '.claude/commands'), { recursive: true })
    symlinkSync(join(root, 'outside'), join(box, '.claude/commands/evil'))
    const entries = [
      entry('../escape.md', 'x'),
      entry('.claude/.credentials.json', 'x'),
      entry('.codex/auth.json', 'x'),
      entry('.claude/settings.local.json', 'x'),
      entry('.ssh/authorized_keys', 'x'),
      entry('.claude/commands/evil/x.md', 'x'),
      entry('.claude/commands/ok.md', 'ok')
    ]
    const answer = await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g1', entries })
    expect(answer).toEqual({ need: ['.claude/commands/ok.md'], remove: [], refused: 6 })
    expect(boxLog.filter((l) => l.startsWith('refused')).length).toBe(6)
    expect(() => receiver.handleFile({ generation: 'g1', relPath: '.claude/.credentials.json', chunkIndex: 0, chunks: 1, dataBase64: b64('x') })).toThrow(/not a file this generation needs/)
    receiver.handleFile({ generation: 'g1', relPath: '.claude/commands/ok.md', chunkIndex: 0, chunks: 1, dataBase64: b64('ok') })
    await receiver.handleCommit({ generation: 'g1' })
    expect(read(box, '.claude/commands/ok.md')).toBe('ok')
    expect(existsSync(join(root, 'outside/x.md'))).toBe(false)
    expect(has(box, '.claude/.credentials.json')).toBe(false)
  })

  it('discards a generation a newer manifest replaced, and refuses a commit whose bytes do not match the hash', async () => {
    const { receiver } = pair()
    const e = entry('.claude/commands/a.md', 'right')
    await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g1', entries: [e] })
    receiver.handleFile({ generation: 'g1', relPath: e.relPath, chunkIndex: 0, chunks: 1, dataBase64: b64('right') })
    await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g2', entries: [e] })
    expect(() => receiver.handleFile({ generation: 'g1', relPath: e.relPath, chunkIndex: 0, chunks: 1, dataBase64: b64('right') })).toThrow(/not the current generation/)
    await expect(receiver.handleCommit({ generation: 'g1' })).rejects.toThrow(/not the current generation/)
    await expect(receiver.handleCommit({ generation: 'g2' })).rejects.toThrow(/incomplete/)
    await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g3', entries: [e] })
    receiver.handleFile({ generation: 'g3', relPath: e.relPath, chunkIndex: 0, chunks: 1, dataBase64: b64('wrong') })
    await expect(receiver.handleCommit({ generation: 'g3' })).rejects.toThrow(/does not match its hash/)
    expect(has(box, e.relPath)).toBe(false)
    expect(existsSync(join(root, 'box-data/harness-sync/staging'))).toBe(false)
  })

  it('an older sender\'s skill files are neither needed nor refused, said in one line per manifest', async () => {
    const { receiver, boxLog } = pair()
    const entries = [entry('.claude/skills/a/SKILL.md', 'a'), entry('.agents/skills/b/SKILL.md', 'b'), entry('.config/muse/skills/c/SKILL.md', 'c'), entry('.claude/commands/ok.md', 'ok')]
    const answer = await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g1', entries })
    expect(answer).toEqual({ need: ['.claude/commands/ok.md'], remove: [], refused: 0 })
    expect(boxLog.filter((l) => l.includes('retired skill roots ignored'))).toEqual(['3 files under retired skill roots ignored (skills come from the store)'])
    expect(boxLog.some((l) => l.startsWith('refused'))).toBe(false)
  })

  it('forgets the skill files an earlier build landed, at start and at a manifest, and leaves them on disk', async () => {
    const { receiver, boxLog } = pair()
    // What an earlier build's sync landed and recorded.
    put(box, '.claude/skills/old/SKILL.md', 'landed by an old sync')
    put(box, '.agents/skills/shared/SKILL.md', 'landed too')
    put(box, '.claude/commands/kept.md', 'kept')
    const land = (relPath: string, body: string) => ({ src: createHash('sha256').update(body).digest('hex'), landed: createHash('sha256').update(body).digest('hex'), size: body.length, mtimeMs: statSync(join(box, relPath)).mtimeMs, mode: 0o644, tx: '' })
    mkdirSync(join(root, 'box-data/harness-sync'), { recursive: true })
    const ledgerPath = join(root, 'box-data/harness-sync/ledger.json')
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        from: 'env_mac',
        claudeKeys: [],
        files: { '.claude/skills/old/SKILL.md': land('.claude/skills/old/SKILL.md', 'landed by an old sync'), '.agents/skills/shared/SKILL.md': land('.agents/skills/shared/SKILL.md', 'landed too'), '.claude/commands/kept.md': land('.claude/commands/kept.md', 'kept') }
      })
    )
    receiver.start()
    await new Promise((r) => setTimeout(r, 0))
    expect(Object.keys(JSON.parse(readFileSync(ledgerPath, 'utf8')).files)).toEqual(['.claude/commands/kept.md'])
    expect(boxLog).toContain('forgot 2 landed files under the retired skill roots; they stay on disk (skills come from the store)')
    // A new manifest lists no skill: nothing is removed under the retired roots, the files stay.
    const answer = await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g1', entries: [entry('.claude/commands/kept.md', 'kept')] })
    expect(answer.remove).toEqual([])
    expect(read(box, '.claude/skills/old/SKILL.md')).toBe('landed by an old sync')
    expect(read(box, '.agents/skills/shared/SKILL.md')).toBe('landed too')
    // A ledger an old build writes again (between restarts) is cleaned at the next manifest too.
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    ledger.files['.claude/skills/old/SKILL.md'] = land('.claude/skills/old/SKILL.md', 'landed by an old sync')
    writeFileSync(ledgerPath, JSON.stringify(ledger))
    const again = await receiver.handleManifest({ from: 'env_mac', home: '/Users/landon', generation: 'g2', entries: [] })
    expect(again.remove).toEqual(['.claude/commands/kept.md'])
    expect(has(box, '.claude/skills/old/SKILL.md')).toBe(true)
  })

  it('uses the shipped history map until the setting replaces it', () => {
    const { receiver, boxStore } = pair()
    expect(receiver.translationFor('/Users/landon').roots['/Users/landon/IdeaProjects/temp-code']).toBe('/srv/agents/work/temp-code')
    boxStore.setSetting(PATH_MAP_KEY, JSON.stringify({ roots: {}, prefixes: {} }))
    expect(receiver.translationFor('/Users/landon')).toEqual({ roots: {}, prefixes: { '/Users/landon/IdeaProjects': work, '/Users/landon/Desktop/Websites': work, '/Users/landon': box } })
  })
})

describe('hook executables', () => {
  it('names the executable past env assignments and quotes', () => {
    expect(commandExecutable('FOO=1 BAR="a b" terminal-notifier -message hi')).toBe('terminal-notifier')
    expect(commandExecutable('"/opt/my tool/run" x')).toBe('/opt/my tool/run')
  })
  it('lists the ones not found, absolute or on PATH; builtins and variables are not judged', () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'tc-no-such-tool -e x' }, { type: 'command', command: 'sh -c true' }, { type: 'command', command: 'echo hi' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/Applications/X.app/bin/x' }, { type: 'command', command: '$HOME/bin/y' }] }]
      }
    })
    expect(missingHookExecutables(settings, { PATH: '/usr/bin:/bin', home: box }).sort()).toEqual(['/Applications/X.app/bin/x', 'tc-no-such-tool'])
  })
})

it('HARNESS_SET roots are clean relative paths', () => {
  for (const r of HARNESS_SET) expect(validRelPath(r.kind === 'tree' ? r.root : r.path)).toBe(true)
})

describe('stripHostBoundToml', () => {
  it('drops a top-level base_url that points at the sender loopback and keeps everything else', async () => {
    const { stripHostBoundToml } = await import('./harnessSync')
    const toml = 'model = "x"\nchatgpt_base_url = "https://127.0.0.1:8789/codex"\n[model_providers.a]\nbase_url = "http://localhost:1/keep"\n'
    const r = stripHostBoundToml(toml)
    expect(r.dropped).toEqual(['chatgpt_base_url'])
    expect(r.text).toBe('model = "x"\n[model_providers.a]\nbase_url = "http://localhost:1/keep"\n')
    expect(stripHostBoundToml('model = "x"\nchatgpt_base_url = "https://example.com/codex"\n').dropped).toEqual([])
  })
})
