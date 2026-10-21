/**
 * Harness config sync for real: two isolated headless instances of the
 * BUILT tree (out/main), each with its own HOME, userData, Aliax vault dir,
 * TMPDIR and fixed port, the same way box-update's trial runs a candidate
 * (HOME points at a scratch dir, TEMP_CODE_HEADLESS=1; on Linux under
 * xvfb-run and a private D-Bus, like /usr/local/lib/temp-code/run). Each
 * publishes its local socket in <userData>/server.json and this script
 * speaks to it as the implicit admin, the way scripts/box/tc-local.mjs does.
 *
 * "mac" is seeded with skills, commands, agents, hooks (settings.json's
 * paths and a macOS-only hook, a script under .claude/hooks, Codex's
 * hooks.json with its trust row in config.toml), plugins (records, an
 * installed tree, a marketplace with a .git dir, the directory cache),
 * ~/.claude.json, Codex config, prompts and skills (plus a .system one),
 * .agents skills (an Impeccable-shaped one: SKILL.md, the launcher, VERSION,
 * a Mach-O under scripts/bin, linked into .claude/skills), a Mach-O outside
 * any binary cache, and every kind of secret. "box" has its own sign-in,
 * local settings, account-synced skill bucket and a skill of its own. Then:
 *  - mac turns sending on (headless defaults to receive-only), box issues an
 *    admin key, mac saves box as an environment: the link-up sync lands the
 *    set translated (mac's home → box's, IdeaProjects/X → the box's work
 *    root, a root from box's harness.sync.pathMap setting), binaries byte for
 *    byte, modes kept, the two ~/.claude.json keys merged into box's own
 *  - nothing excluded lands: no credential, auth.json, settings.local.json,
 *    *.pem/*.key, no plugin directory cache, no .git, no .codex/skills/.system,
 *    no Mach-O anywhere (the binary cache is not walked, one elsewhere is
 *    skipped and counted), and box's own files are as they were
 *  - the symlinked skill lands as a real dir on both roots; hooks.json lands
 *    byte for byte and its [hooks.state] row names the box's copy
 *  - box logged the hook executable it cannot find (tc-no-such-tool)
 *  - a deletion and an edit on mac reach box through the watch alone
 *  - a file edited on box is put back by Sync now; a file box made itself stays
 *  - mac's harness.status names box with the file count, each set's count
 *    and no error
 * Run: bun scripts/e2e-harness-sync.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_HS_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

// realpath: on macOS tmpdir() is a symlink under /var, and the box resolves real paths.
const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-harness-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), remote: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')

const put = (home: string, rel: string, body: string | Buffer, mode?: number): void => {
  mkdirSync(dirname(join(home, rel)), { recursive: true })
  writeFileSync(join(home, rel), body)
  if (mode !== undefined) chmodSync(join(home, rel), mode)
}
const read = (home: string, rel: string): string | null => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : null)
const has = (home: string, rel: string): boolean => existsSync(join(home, rel))
const SECRET = `SECRET-${randomBytes(6).toString('hex')}`
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(3000)])
const BIG = randomBytes(5 * 1024 * 1024 + 17)
/** A Mach-O 64-bit little-endian header (what the Mac's arm64 binaries carry) and a body. */
const MACHO = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]), randomBytes(4096)])
const LAUNCHER = '#!/bin/sh\n# Impeccable-shaped launcher: the platform binary beside it, else the version cache.\ndir=$(dirname "$0")\nexec "$dir/bin/$(uname -s)-$(uname -m)/impeccable" "$@"\n'
const HOOKS_JSON = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command: '[ ! -f "$HOME/.agents/skills/impeccable/scripts/impeccable" ] || "$HOME/.agents/skills/impeccable/scripts/impeccable" hook', timeout: 5 }] }] } }, null, 2) + '\n'
const special = join(root, 'box-special', 'proj')

// ── the Mac's HOME ──────────────────────────────────────────────────────
const M = mac.home
put(M, '.claude/settings.json', JSON.stringify({ statusLine: { type: 'command', command: `${M}/.claude/statusline.sh` }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'tc-no-such-tool -e "beep"' }, { type: 'command', command: '/bin/sh -c true' }] }] } }, null, 2))
put(M, '.claude/skills/deploy/SKILL.md', `---\nname: deploy\n---\nRun ${M}/IdeaProjects/shop/bin/deploy, then ${M}/Desktop/Websites/site/build.sh and ${M}/Special/proj/run.\n`)
put(M, '.claude/skills/deploy/go.sh', `#!/bin/sh\ncd ${M}/IdeaProjects/shop && ./bin/deploy\n`, 0o755)
put(M, '.claude/skills/deploy/logo.png', PNG)
put(M, '.claude/skills/deploy/server.pem', SECRET)
put(M, '.claude/skills/deploy/deploy.key', SECRET)
put(M, 'IdeaProjects/repo/skills/linked/SKILL.md', '# linked from a checkout')
symlinkSync(join(M, 'IdeaProjects/repo/skills/linked'), join(M, '.claude/skills/linked'))
put(M, '.claude/skills/synced/acct/SKILL.md', 'the Mac account bucket')
put(M, '.claude/commands/ship.md', 'ship it')
put(M, '.claude/commands/gone.md', 'deleted later')
put(M, '.claude/agents/reviewer.md', 'review carefully')
put(M, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'tool@mkt': [{ scope: 'user', installPath: `${M}/.claude/plugins/cache/mkt/tool/1.0.0`, version: '1.0.0' }] } }, null, 2))
put(M, '.claude/plugins/known_marketplaces.json', JSON.stringify({ mkt: { source: { source: 'github', repo: 'x/mkt' }, installLocation: `${M}/.claude/plugins/marketplaces/mkt` } }, null, 2))
put(M, '.claude/plugins/marketplaces/mkt/.claude-plugin/marketplace.json', '{"name":"mkt"}')
put(M, '.claude/plugins/marketplaces/mkt/.git/HEAD', 'ref: refs/heads/main\n')
put(M, '.claude/plugins/cache/mkt/tool/1.0.0/.claude-plugin/plugin.json', '{"name":"tool"}')
put(M, '.claude/plugins/cache/mkt/tool/1.0.0/bin/tool', BIG, 0o755)
put(M, '.claude/plugins/plugin-directory-cache-v2.json', JSON.stringify({ blob: 'x'.repeat(200_000) }))
put(M, '.claude/plugins/synced/acct.json', 'the Mac plugin bucket')
put(M, '.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }))
put(M, '.claude/settings.local.json', JSON.stringify({ env: { TOKEN: SECRET } }))
put(M, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'mac@example.com', token: SECRET }, userID: SECRET, projects: { [M]: {} }, enabledPlugins: { 'tool@mkt': true }, mcpServers: { files: { command: `${M}/IdeaProjects/shop/mcp.sh`, args: [] } } }, null, 2))
put(M, '.codex/config.toml', `model = "gpt-6.1-sol"\n\n[projects."${M}/IdeaProjects/shop"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n[hooks.state."${M}/.codex/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:84ec1c77bb34b81a"\n`)
put(M, '.codex/hooks.json', HOOKS_JSON)
put(M, '.claude/hooks/lint.sh', `#!/bin/sh\nexec ${M}/IdeaProjects/shop/bin/lint "$@"\n`, 0o755)
put(M, '.codex/prompts/review.md', 'codex review prompt')
put(M, '.codex/skills/mine/SKILL.md', 'codex skill')
put(M, '.codex/skills/.system/builtin/SKILL.md', 'the Mac codex system skill')
put(M, '.codex/auth.json', JSON.stringify({ tokens: { access_token: SECRET } }))
put(M, '.agents/skills/shared/SKILL.md', 'agents skill')
// an Impeccable-shaped skill: SKILL.md, the launcher, the engine version, the per-platform binary beside it; linked into .claude/skills
put(M, '.agents/skills/impeccable/SKILL.md', '---\nname: impeccable\n---\nRun scripts/impeccable.\n')
put(M, '.agents/skills/impeccable/scripts/impeccable', LAUNCHER, 0o755)
put(M, '.agents/skills/impeccable/scripts/VERSION', '0.1.16\n')
put(M, '.agents/skills/impeccable/scripts/command-metadata.json', '{"commands":["audit"]}')
put(M, '.agents/skills/impeccable/agents/impeccable_documenter.toml', 'name = "documenter"\n')
put(M, '.agents/skills/impeccable/scripts/bin/darwin-arm64/impeccable', MACHO, 0o755)
symlinkSync(join('..', '..', '.agents', 'skills', 'impeccable'), join(M, '.claude/skills/impeccable'))
// a Mach-O outside any binary cache: skipped on the Mac and counted
put(M, '.codex/skills/mine/engine', MACHO, 0o755)

// ── the box's HOME ──────────────────────────────────────────────────────
const B = box.home
put(B, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'box@example.com' }, machineID: 'box-machine' }, null, 2))
put(B, '.claude/.credentials.json', '{"box":"own sign-in"}')
put(B, '.claude/settings.local.json', '{"box":"local"}')
put(B, '.claude/skills/synced/acct/SKILL.md', 'the box account bucket')
put(B, '.claude/skills/own/SKILL.md', 'made on the box')
put(B, '.codex/skills/.system/builtin/SKILL.md', 'the box codex system skill')

// ── launch ──────────────────────────────────────────────────────────────
function launch(inst: Inst): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 120_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${inst.name}: ${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const cleanup = async (): Promise<void> => {
  kill(mac)
  kill(box)
  await sleep(1500)
  for (const inst of [mac, box]) {
    try {
      if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

/** Every file under a dir, relative. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]))
}

interface HarnessStatus {
  enabled: boolean
  skipped: number
  environments: { id: string; name: string; connected: boolean; files: number | null; sets: Record<string, number> | null; syncedAt: number | null; error: string | null }[]
}

launch(mac)
launch(box)
try {
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macHello = await rpc<{ environmentId: string }>(mac, 'remote.status')
  const boxHello = await rpc<{ environmentId: string; port: number; running: boolean }>(box, 'remote.status')
  log(`mac ${macHello.environmentId}, box ${boxHello.environmentId} on :${box.remote}; logs ${mac.log} ${box.log}`)
  check('box: the fixed-port listener is up on its own port', boxHello.running && boxHello.port === box.remote, JSON.stringify(boxHello))

  // ── 0. defaults: a headless host receives only ───────────────────────
  check('mac: a headless host does not send until told to', (await rpc<HarnessStatus>(mac, 'harness.status')).enabled === false)
  await rpc(box, 'harness.settings.set', { pathMap: { roots: { [`${M}/Special/proj`]: special }, prefixes: {} } })
  const wr = await rpc<{ root: string; home: string }>(box, 'workspace.root')
  const workFor = (x: string): string => (wr.root !== wr.home ? `${wr.root}/${x}` : `${B}/IdeaProjects/${x}`)
  log(`box work root ${wr.root}`)
  await rpc(mac, 'harness.settings.set', { enabled: true })

  // ── 1. pair: box issues an admin key, mac saves box; the link-up sync lands the set ──
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const landed = await until('the first sync lands', 60_000, async () => {
    const s = await rpc<HarnessStatus>(mac, 'harness.status')
    return s.environments[0]?.syncedAt != null
  })
  check('mac: the link-up sync committed on box', landed, logOf(mac).split('\n').filter((l) => l.includes('[harness-sync]')).join(' | '))

  const skill = read(B, '.claude/skills/deploy/SKILL.md') ?? ''
  check('a skill landed, its Mac paths translated (home, IdeaProjects, Desktop/Websites, the pathMap root)', skill === `---\nname: deploy\n---\nRun ${workFor('shop')}/bin/deploy, then ${workFor('site')}/build.sh and ${special}/run.\n`, JSON.stringify(skill))
  check('a script landed translated and executable', read(B, '.claude/skills/deploy/go.sh') === `#!/bin/sh\ncd ${workFor('shop')} && ./bin/deploy\n` && (statSync(join(B, '.claude/skills/deploy/go.sh')).mode & 0o777) === 0o755)
  check('a binary landed byte for byte', readFileSync(join(B, '.claude/skills/deploy/logo.png')).equals(PNG))
  check('a skill symlinked in from a checkout landed as its content', read(B, '.claude/skills/linked/SKILL.md') === '# linked from a checkout')
  check('a 5 MiB plugin binary crossed in chunks and landed whole, executable', has(B, '.claude/plugins/cache/mkt/tool/1.0.0/bin/tool') && createHash('sha256').update(readFileSync(join(B, '.claude/plugins/cache/mkt/tool/1.0.0/bin/tool'))).digest('hex') === createHash('sha256').update(BIG).digest('hex') && (statSync(join(B, '.claude/plugins/cache/mkt/tool/1.0.0/bin/tool')).mode & 0o111) !== 0)
  const settings = JSON.parse(read(B, '.claude/settings.json') ?? '{}')
  check('settings.json landed with the statusline path translated', settings.statusLine?.command === `${B}/.claude/statusline.sh`, JSON.stringify(settings.statusLine))
  const installed = JSON.parse(read(B, '.claude/plugins/installed_plugins.json') ?? '{}')
  check('installed_plugins.json points at the box\'s plugin cache', installed.plugins?.['tool@mkt']?.[0]?.installPath === `${B}/.claude/plugins/cache/mkt/tool/1.0.0`)
  check('commands, agents, the marketplace, Codex config/prompts/skills and .agents skills landed', ['.claude/commands/ship.md', '.claude/agents/reviewer.md', '.claude/plugins/known_marketplaces.json', '.claude/plugins/marketplaces/mkt/.claude-plugin/marketplace.json', '.codex/prompts/review.md', '.codex/skills/mine/SKILL.md', '.agents/skills/shared/SKILL.md'].every((r) => has(B, r)))
  check('config.toml trusts the project at its box path', (read(B, '.codex/config.toml') ?? '').includes(`[projects."${workFor('shop')}"]`), read(B, '.codex/config.toml') ?? '')
  check('Codex hooks.json landed byte for byte ($HOME, not a Mac path)', read(B, '.codex/hooks.json') === HOOKS_JSON, JSON.stringify(read(B, '.codex/hooks.json')))
  check('config.toml\'s [hooks.state] row names the box\'s hooks.json with the trusted hash kept', (read(B, '.codex/config.toml') ?? '').includes(`[hooks.state."${B}/.codex/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:84ec1c77bb34b81a"`), read(B, '.codex/config.toml') ?? '')
  check('a Claude hook script landed translated and executable', read(B, '.claude/hooks/lint.sh') === `#!/bin/sh\nexec ${workFor('shop')}/bin/lint "$@"\n` && (statSync(join(B, '.claude/hooks/lint.sh')).mode & 0o111) !== 0)
  for (const r of ['.agents/skills/impeccable', '.claude/skills/impeccable']) {
    const link = existsSync(join(B, r)) && lstatSync(join(B, r)).isSymbolicLink()
    check(`${r}: the Impeccable-shaped skill landed as a real dir with SKILL.md, the launcher (executable), VERSION, metadata and agents`, !link && read(B, `${r}/SKILL.md`) === '---\nname: impeccable\n---\nRun scripts/impeccable.\n' && read(B, `${r}/scripts/impeccable`) === LAUNCHER && (statSync(join(B, `${r}/scripts/impeccable`)).mode & 0o111) !== 0 && read(B, `${r}/scripts/VERSION`) === '0.1.16\n' && has(B, `${r}/scripts/command-metadata.json`) && has(B, `${r}/agents/impeccable_documenter.toml`), walk(join(B, r)).join(','))
    check(`${r}: the per-platform binary cache never crossed`, !has(B, `${r}/scripts/bin`))
  }
  const cj = JSON.parse(read(B, '.claude.json') ?? '{}')
  check('~/.claude.json: enabledPlugins and mcpServers merged (translated), box\'s own keys kept, no other Mac key', JSON.stringify(cj) === JSON.stringify({ oauthAccount: { emailAddress: 'box@example.com' }, machineID: 'box-machine', enabledPlugins: { 'tool@mkt': true }, mcpServers: { files: { command: `${workFor('shop')}/mcp.sh`, args: [] } } }), JSON.stringify(cj))

  // ── 2. nothing excluded landed; box's own files untouched ────────────
  const boxFiles = walk(B)
  check('no secret marker anywhere under box\'s HOME', !boxFiles.some((r) => readFileSync(join(B, r)).includes(SECRET)))
  check('no .pem/.key, auth.json; box\'s own credentials and local settings as they were', !has(B, '.claude/skills/deploy/server.pem') && !has(B, '.claude/skills/deploy/deploy.key') && !has(B, '.codex/auth.json') && read(B, '.claude/.credentials.json') === '{"box":"own sign-in"}' && read(B, '.claude/settings.local.json') === '{"box":"local"}')
  check('no plugin directory cache, no .git, no plugins/synced', !has(B, '.claude/plugins/plugin-directory-cache-v2.json') && !has(B, '.claude/plugins/marketplaces/mkt/.git') && !has(B, '.claude/plugins/synced'))
  const machOs = boxFiles.filter((r) => {
    const b = readFileSync(join(B, r))
    return b.length >= 8 && b.readUInt32BE(0) === 0xcffaedfe
  })
  check('no Mach-O anywhere under box\'s HOME (the one outside a binary cache was skipped on the Mac)', machOs.length === 0 && !has(B, '.codex/skills/mine/engine') && has(B, '.codex/skills/mine/SKILL.md'), machOs.join(','))
  check('the account buckets and .codex/skills/.system are box\'s own', read(B, '.claude/skills/synced/acct/SKILL.md') === 'the box account bucket' && read(B, '.codex/skills/.system/builtin/SKILL.md') === 'the box codex system skill')

  // ── 3. the hook line ─────────────────────────────────────────────────
  check('box logged the hook executable it cannot find', logOf(box).includes("settings.json landed; hook commands not on this host's PATH: tc-no-such-tool"), logOf(box).split('\n').filter((l) => l.includes('settings.json landed')).join(' | '))

  // ── 4. the watch: a deletion and an edit on mac reach box with no Sync now ──
  rmSync(join(M, '.claude/commands/gone.md'))
  put(M, '.claude/commands/ship.md', 'ship it, edited on the Mac')
  const watched = await until('the watch carries the change', 30_000, () => !has(B, '.claude/commands/gone.md') && read(B, '.claude/commands/ship.md') === 'ship it, edited on the Mac')
  check('a deletion and an edit on mac mirrored through the watch', watched)
  rmSync(join(M, '.claude/skills/deploy'), { recursive: true })
  check('a removed skill dir mirrored, the dir pruned', await until('the skill dir goes', 30_000, () => !has(B, '.claude/skills/deploy')))
  check('box\'s own skill stays', read(B, '.claude/skills/own/SKILL.md') === 'made on the box')

  // ── 5. box drifts: Sync now puts the Mac's copy back ─────────────────
  put(B, '.claude/agents/reviewer.md', 'edited on the box')
  const after = await rpc<HarnessStatus>(mac, 'harness.sync', {})
  check('Sync now restored the Mac\'s copy over a box edit', read(B, '.claude/agents/reviewer.md') === 'review carefully')
  const env = after.environments[0]
  check('mac: harness.status names box with the count, a time and no error', env?.name === 'box' && env.connected && (env.files ?? 0) > 10 && env.error === null && (env.syncedAt ?? 0) > 0, JSON.stringify(after))
  const sets = env?.sets ?? {}
  check('mac: harness.status carries each set\'s count (Codex hooks 1, Claude hooks 1, the shared and Claude skills, the sum is the file count)', sets['Codex hooks'] === 1 && sets['Claude hooks'] === 1 && (sets['Shared skills'] ?? 0) >= 6 && (sets['Claude skills'] ?? 0) >= 5 && sets['Codex skills'] === 1 && Object.values(sets).reduce((a, b) => a + b, 0) === env?.files, JSON.stringify(sets))
  check('mac: the Mach-O outside a binary cache is the one skipped file (the 5 MiB plugin binary is under the budget)', after.skipped === 1, String(after.skipped))
  log(`status: box — ${env?.files} files ${JSON.stringify(sets)}, skipped on mac ${after.skipped}`)
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
