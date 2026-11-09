/** One disposable instance, real CLI processes, and loopback providers only. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { makeCertificate } from '../../src/main/server/tls'
import {
  placeholderClaudeCredentials,
  placeholderCodexAuth,
  placeholderMuseAuth,
  PLACEHOLDER_EMAIL
} from './configDirSpike'
import { preferredProofBun, runProofBun } from './proofBun'
import { waitForGateBuild } from './gateBuild'
import { FakeAnthropic, FakeResponses, skillCall, sleep } from './spikeFakes'
import { proxyPeerPid } from './skillsDriversPeers'
import {
  claudeJudgeFailure,
  composeGatePath,
  GATE_CLIS,
  resolveGateCli,
  shellWord,
  type GateCli
} from './gateCli'
import {
  advertisedSkillFile,
  argvFromPs,
  carriesNonce,
  disabledSkillPaths,
  hasSkillSet,
  isLoopbackTarget,
  isHousekeepingConnect,
  listingVerdict,
  museHomeGap,
  PROBE_SKILL,
  HOME_SKILL,
  skillListing
} from './skillsDriversProof'

interface ProcessRow {
  pid: number
  argv: string[]
  env: Map<string, string>
}
/** Linux's NUL argv and the Mac's ps spelling: both remain scoped to our temp data. */
function instanceProcesses(data: string): ProcessRow[] {
  if (process.platform === 'linux') {
    return readdirSync('/proc')
      .filter((n) => /^\d+$/.test(n))
      .flatMap((n) => {
        try {
          const env = new Map(
            readFileSync(`/proc/${n}/environ`, 'utf8')
              .split('\0')
              .filter((x) => x.includes('='))
              .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])
          )
          return env.get('TEMP_CODE_USER_DATA') === data
            ? [
                {
                  pid: Number(n),
                  argv: readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean),
                  env
                }
              ]
            : []
        } catch {
          return []
        }
      })
  }
  const ps = execFileSync('ps', ['-axwwE', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) return []
    const env = new Map(
      [...m[2].matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)].map((x) => [x[1], x[2]])
    )
    return env.get('TEMP_CODE_USER_DATA') === data
      ? [{ pid: Number(m[1]), argv: argvFromPs(m[2]), env }]
      : []
  })
}

const listen = (s: Server): Promise<string> =>
  new Promise((ok, bad) => {
    s.once('error', bad)
    s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`))
  })
const close = (s: Server): void => {
  s.closeAllConnections()
  s.close()
}
const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const md = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: Skills drivers gate probe.\n---\n${body}\n`
function seedVault(dir: string): void {
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  const blobs = {
    'claude-code': JSON.stringify({
      keychain: placeholderClaudeCredentials(),
      oauthAccount: { accountUuid: 'tc-placeholder-account', emailAddress: PLACEHOLDER_EMAIL }
    }),
    codex: placeholderCodexAuth(),
    'muse-code': placeholderMuseAuth()
  }
  writeFileSync(
    join(dir, 'profiles.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.keys(blobs).map((service) => [
          service,
          [
            {
              name: PLACEHOLDER_EMAIL,
              accountId: 'tc-placeholder-account',
              email: PLACEHOLDER_EMAIL,
              static: service === 'muse-code',
              createdAt: Date.now()
            }
          ]
        ])
      )
    )
  )
  for (const [service, blob] of Object.entries(blobs))
    writeFileSync(
      join(dir, 'secrets', `${service}__${encodeURIComponent(PLACEHOLDER_EMAIL)}.bin`),
      chromiumEncrypt(deriveChromiumKey(password), blob)
    )
}

interface Row {
  seq: number
  event: { type: string; text?: string; delta?: boolean; status?: string; message?: string }
}
interface Warm {
  driver: string
  warm: unknown[]
  adopted: number
  misses: Record<string, number>
}
interface Seen {
  body: unknown
  main: boolean
}

export async function runSkillsDriversGate(repo: string): Promise<number> {
  const log = (s: string): void => console.log(`      ${s}`)
  let passes = 0,
    failures = 0,
    skips = 0
  const check = (s: string, ok: boolean, detail = ''): boolean => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}${!ok && detail ? ` — ${detail}` : ''}`)
    ok ? passes++ : failures++
    return ok
  }
  const skip = (s: string): void => {
    console.log(`SKIP  ${s}`)
    skips++
  }
  // A gate must wait before it starts any instance, and must never build.
  await waitForGateBuild({ tree: repo, log })
  const runtime = preferredProofBun(process.execPath, process.env.HOME || homedir())
  if (runtime) {
    log(`using the user's Bun for the gate: ${runtime}`)
    return runProofBun(runtime, join(repo, 'scripts/e2e-skills-drivers.ts'), process.argv.slice(2))
  }
  log(`gate runtime: Bun ${process.versions.bun ?? 'unknown'} (${process.execPath})`)
  // Resolve before substituting HOME: the login shell must read the real user's profile.
  const callerEnv = { ...process.env }
  const realHome = callerEnv.HOME || homedir()
  const binaries = Object.fromEntries(
    GATE_CLIS.map((name) => [
      name,
      resolveGateCli(name, {
        home: realHome,
        env: callerEnv,
        platform: process.platform,
        probe: (shell, args, env) =>
          execFileSync(shell, args, {
            env,
            cwd: realHome,
            encoding: 'utf8',
            timeout: 20_000,
            stdio: ['ignore', 'pipe', 'pipe']
          }),
        executable: (path) => {
          try {
            accessSync(path, constants.X_OK)
            return statSync(path).isFile()
          } catch {
            return false
          }
        }
      })
    ])
  ) as Record<GateCli, string | null>
  for (const name of GATE_CLIS) log(`${name} binary: ${binaries[name] ?? 'unresolved'}`)
  let claudeNotJudgedWhy = binaries.claude
    ? 'the Claude leg did not finish'
    : callerEnv.TC_SD_GATE_CLAUDE_BIN !== undefined
      ? `TC_SD_GATE_CLAUDE_BIN is not an executable absolute path (${callerEnv.TC_SD_GATE_CLAUDE_BIN})`
      : 'binary not found through the real login shell, caller PATH, or app user bin dirs'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-skills-gate-')))
  const home = join(root, 'home'),
    data = join(root, 'data'),
    work = join(home, 'work'),
    tmp = join(root, 'tmp')
  const appLog = join(root, 'app.log'),
    vault = join(data, 'aliax')
  for (const dir of [home, data, work, tmp]) mkdirSync(dir, { recursive: true })
  // A fresh Chromium session otherwise fetches a spellcheck dictionary from Google.
  put(
    join(data, 'Preferences'),
    JSON.stringify({ browser: { enable_spellchecking: false }, spellcheck: { dictionaries: [] } })
  )
  log(`skills drivers gate: ${root}`)
  skip(
    'real-model and real-HOME legs: hand run only; gate uses placeholder accounts and a temp HOME'
  )
  const nonce = randomBytes(4).toString('hex')
  const word = (n: number): string => `PROBE-N${n}-${nonce}`
  const homeFiles = [
    '.claude/skills',
    '.agents/skills',
    '.codex/skills',
    '.config/muse/skills'
  ].map((p) => join(home, p, HOME_SKILL, 'SKILL.md'))
  for (const path of homeFiles) put(path, md(HOME_SKILL, 'HOME-ONLY-DO-NOT-IMPORT'))
  put(join(home, '.claude', '.credentials.json'), placeholderClaudeCredentials())
  put(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
  put(join(home, '.codex', 'auth.json'), placeholderCodexAuth())
  put(join(home, '.config', 'muse', 'auth.json'), placeholderMuseAuth())
  seedVault(vault)
  // Before the first boot: the Mac import must never turn the negative control into a store row.
  const db = new Database(join(data, 'temp-code.db'))
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'skills-imported:v1',
    JSON.stringify({ at: Date.now(), imported: 0, merged: 0, skipped: 0 })
  )
  db.close()
  await makeCertificate(join(data, 'tls'), 'Skills Gate CA')
  const tls = {
    cert: readFileSync(join(data, 'tls/cert.pem')),
    key: readFileSync(join(data, 'tls/key.pem'))
  }
  const ca = readFileSync(join(data, 'tls/ca.pem'))
  const anthropic = new FakeAnthropic(),
    responses = new FakeResponses(tls)
  const claudeRequests: Seen[] = [],
    responseRequests: Seen[] = []
  anthropic.inspect = (body, rec) => {
    claudeRequests.push({ body, main: rec.main })
    put(join(root, 'claude-bodies.json'), JSON.stringify(claudeRequests))
  }
  responses.isMain = (body, role) =>
    (!role || role === 'main') && Array.isArray((body as { input?: unknown }).input)
  responses.inspect = (body, rec) => {
    responseRequests.push({ body, main: rec.main })
    put(join(root, 'response-bodies.json'), JSON.stringify(responseRequests))
  }
  responses.museModels = readFileSync(join(repo, 'scripts/lib/fixtures/muse-models.json'), 'utf8')
  const denied: string[] = []
  const housekeeping: string[] = []
  let phase = 'boot'
  const traceOutbound = (method: string, target: string, clientPort = 0, proxyPort = 0) => {
    const pid = proxyPeerPid(clientPort, proxyPort)
    const owner = instanceProcesses(data).find((p) => p.pid === pid)
    const record = { phase, method, target, clientPort, pid, argv: owner?.argv ?? [] }
    appendFileSync(join(root, 'outbound.jsonl'), `${JSON.stringify(record)}\n`)
    log(
      `outbound ${target}: pid ${pid ?? 'unknown'}, phase ${phase}, ${owner?.argv.slice(0, 5).join(' ') ?? 'process exited'}`
    )
    return record
  }
  const proxy = createServer((req, res) => {
    traceOutbound(req.method ?? '', req.url ?? '', req.socket.remotePort, req.socket.localPort)
    denied.push(`${req.method} ${req.url}`)
    res.writeHead(502)
    res.end('gate: outbound request refused')
  })
  proxy.on('connect', (req, socket) => {
    const peer = traceOutbound('CONNECT', req.url ?? '', socket.remotePort, socket.localPort)
    if (isHousekeepingConnect(req.url ?? '', peer.argv)) {
      housekeeping.push(`CONNECT ${req.url} (Chromium network service pid ${peer.pid})`)
      log(`housekeeping CONNECT refused: ${req.url}; exact Chromium dictionary-host exception`)
    } else denied.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  // One provider origin dispatches locally to the spike's two wire formats.
  const router = createServer((req, res) => {
    const path = req.url ?? '/'
    const target = /\/v1\/messages(?:\/|\?|$)|\/api\/oauth\//.test(path)
      ? anthropic.url
      : responses.url
    if (!isLoopbackTarget(target)) {
      denied.push(target)
      res.writeHead(502)
      res.end()
      return
    }
    const upstream = (target.startsWith('https:') ? httpsRequest : httpRequest)(
      `${target}${path}`,
      { method: req.method, headers: req.headers, ca },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  let app: ChildProcess | undefined, cleaning: Promise<void> | undefined
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      // Scan before signalling: children may be reparented when the wrapper exits.
      const owned = instanceProcesses(data).map((p) => p.pid)
      if (app?.pid) {
        try {
          process.kill(-app.pid, 'SIGTERM')
        } catch {
          /* gone */
        }
      }
      for (const pid of owned) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* gone */
        }
      }
      await sleep(1200)
      if (app?.pid) {
        try {
          process.kill(-app.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      for (const pid of new Set([...owned, ...instanceProcesses(data).map((p) => p.pid)])) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      anthropic.close()
      responses.close()
      close(router)
      close(proxy)
    })())
  const onSignal = (): void => {
    void cleanup().then(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  // A synchronous last resort covers an unexpected process exit as well.
  const onExit = (): void => {
    for (const p of instanceProcesses(data)) {
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    if (app?.pid) {
      try {
        process.kill(-app.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
  process.once('exit', onExit)
  const until = async (
    label: string,
    ms: number,
    test: () => boolean | Promise<boolean>
  ): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await test()) return true
      if (app && (app.exitCode !== null || app.signalCode !== null))
        throw new Error(`instance exited during ${label}; ${appLog}`)
      await sleep(200)
    }
    log(`timed out: ${label}`)
    return false
  }
  let rpcId = 0
  const rpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
    const port = (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number })
      .port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`),
      id = `gate-${++rpcId}`
    return new Promise<T>((ok, bad) => {
      const timer = setTimeout(() => {
        ws.close()
        bad(new Error(`no answer: ${method}`))
      }, 30_000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(String(ev.data)) as {
          id?: string
          ok?: boolean
          result: T
          error?: string
        }
        if (frame.id !== id) return
        clearTimeout(timer)
        ws.close()
        frame.ok ? ok(frame.result) : bad(new Error(frame.error))
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        ws.close()
        bad(new Error(`socket error: ${method}`))
      })
    })
  }
  const events = (id: string): Promise<Row[]> =>
    rpc('session.events', { sessionId: id, afterSeq: 0 })
  const lastTurn = (rows: Row[]): Row[] =>
    rows.slice(rows.findLastIndex((r) => r.event.type === 'user-text') + 1)
  const settle = async (id: string): Promise<Row[]> => {
    if (
      !(await until('turn settles', 60_000, async () =>
        lastTurn(await events(id)).some(
          (r) =>
            r.event.type === 'turn-complete' ||
            r.event.type === 'error' ||
            (r.event.type === 'status' && ['idle', 'error'].includes(r.event.status ?? ''))
        )
      ))
    )
      throw new Error(`turn timed out: ${id}`)
    return events(id)
  }
  const prompt = `Use the ${PROBE_SKILL} skill now, reading it afresh. Reply with the probe word.`
  const start = async (
    provider: string,
    model: string,
    cwd: string
  ): Promise<{ id: string; rows: Row[] }> => {
    mkdirSync(cwd, { recursive: true })
    const { id } = await rpc<{ id: string }>('session.create', {
      provider,
      model,
      cwd,
      workspaceId: null,
      title: `gate skills ${provider}`,
      reasoning: 'low',
      permission: 'auto',
      threadType: 'chat',
      agentType: 'implementer',
      firstMessage: prompt
    })
    return { id, rows: await settle(id) }
  }
  const next = async (id: string): Promise<Row[]> => {
    await rpc('session.send', { sessionId: id, text: `${prompt} The store has changed.` })
    return settle(id)
  }
  let skill: { id: string; updatedAt: number } | undefined
  const write = async (n: number): Promise<void> => {
    const out = await rpc<{ skill: { id: string; updatedAt: number } }>('skills.set', {
      skill: {
        ...(skill ? { id: skill.id } : {}),
        name: PROBE_SKILL,
        workspaceId: null,
        harnesses: 'all',
        enabled: true,
        files: [{ path: 'SKILL.md', text: md(PROBE_SKILL, `The probe word is ${word(n)}.`) }]
      },
      expectUpdatedAt: skill?.updatedAt ?? 0
    })
    skill = out.skill
    if (
      !(await until('skill pointers', 20_000, () =>
        ['claude', 'codex', 'muse'].every((p) => {
          try {
            return readFileSync(
              join(data, 'harness', p, 'scope', 'global', 'skills', PROBE_SKILL, 'SKILL.md'),
              'utf8'
            ).includes(word(n))
          } catch {
            return false
          }
        })
      ))
    )
      throw new Error('store pointers did not move')
  }
  const warm = async (): Promise<Warm | undefined> =>
    (await rpc<Warm[]>('harness.warm')).find((w) => w.driver === 'claude')
  const misses = (w: Warm | undefined): number =>
    Object.values(w?.misses ?? {}).reduce((a, b) => a + b, 0)
  const cli = (id: string, provider: string): ProcessRow | undefined =>
    instanceProcesses(data)
      .sort((a, b) => a.pid - b.pid)
      .find((p) =>
        provider === 'claude'
          ? p.env.get('CLAUDE_CONFIG_DIR') === join(data, 'harness/claude-config/global') &&
            /claude/.test(p.argv.join(' '))
          : p.env.get('TEMP_CODE_THREAD') === id && p.argv.includes('app-server')
      )
  const bodyReached = (requests: Seen[], mark: number, n: number): boolean =>
    requests
      .slice(mark)
      .filter((r) => r.main)
      .some((r) => carriesNonce(r.body, word(n)))
  const errors = (rows: Row[]): string =>
    lastTurn(rows)
      .filter((r) => r.event.type === 'error')
      .map((r) => r.event.message ?? r.event.text)
      .join(' | ')
  const judges: string[] = []
  try {
    await anthropic.start()
    await responses.start()
    const origin = await listen(router),
      proxyOrigin = await listen(proxy)
    check('fake provider origin is loopback', isLoopbackTarget(origin))
    // 0.163's recorded wire capabilities, with minimal text for a fake model:
    // the CLI otherwise refreshes its catalog at the fixed chatgpt.com origin.
    put(
      join(home, '.codex/models.json'),
      readFileSync(join(repo, 'scripts/lib/fixtures/codex-models.json'), 'utf8')
    )
    // Codex's pre-thread discovery must use its own temp config, too.
    put(
      join(home, '.codex', 'config.toml'),
      `chatgpt_base_url = "${responses.url}/backend-api/"\ncheck_for_update_on_startup = false\nmodel_catalog_json = "${join(home, '.codex/models.json')}"\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`
    )
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const museBin = binaries.muse
    if (museBin) {
      put(
        join(bin, 'muse'),
        `#!/bin/bash\nexec ${shellWord(museBin)} "$@" -c ${shellWord(`endpoint_transport.base_url="${origin}"`)} ${process.platform === 'linux' ? '--disable-sandbox' : ''}\n`
      )
      execFileSync('chmod', ['+x', join(bin, 'muse')])
    }
    const childPath = composeGatePath(
      GATE_CLIS.map((name) => binaries[name]),
      callerEnv.PATH ?? '',
      bin
    )
    put(join(home, '.bash_profile'), `export PATH=${shellWord(childPath)}\n`)
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: childPath,
      HOME: home,
      TMPDIR: tmp,
      SHELL: '/bin/bash',
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local/state'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      TEMP_CODE_HEADLESS: '1',
      TEMP_CODE_USER_DATA: data,
      TEMP_CODE_REMOTE_PORT: '0',
      TEMP_CODE_WORK_ROOT: work,
      TEMP_CODE_ALIAX_DATA_DIR: vault,
      TEMP_CODE_FAKE_PROVIDERS: origin,
      TEMP_CODE_GATEWAY_ROLE: 'owner',
      TEMP_CODE_CLAIM_SHIM: '0',
      ALIAX_SHIM_PORT: '1',
      ALIAX_CREDENTIAL_BACKEND: 'file',
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      TBH_CREDENTIAL_BACKEND: 'file',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      MUSE_NO_AUTO_UPDATE: '1',
      MUSE_CONTRIBUTOR_MODE: '0',
      CODEX_CA_CERTIFICATE: join(data, 'tls/ca.pem'),
      NODE_OPTIONS: `--require=${join(repo, 'scripts/lib/skillsDriversNetwork.cjs')}`,
      TEMP_CODE_GATE_DENIED: join(root, 'denied.log'),
      HTTP_PROXY: proxyOrigin,
      HTTPS_PROXY: proxyOrigin,
      ALL_PROXY: proxyOrigin,
      http_proxy: proxyOrigin,
      https_proxy: proxyOrigin,
      all_proxy: proxyOrigin,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
      NODE_ENV: 'production'
    }
    for (const key of Object.keys(env))
      if (
        /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_TOKEN$|TEMP_CODE_HUB_|TEMP_CODE_DEBUG_PORT$|ELECTRON_RUN_AS_NODE$)/.test(
          key
        )
      )
        delete env[key]
    const electron = join(repo, 'node_modules/.bin/electron')
    const args = [
      '.',
      '--disable-component-update',
      '--disable-background-networking',
      `--proxy-server=${proxyOrigin}`,
      '--proxy-bypass-list=<-loopback>;127.0.0.1;localhost;[::1]'
    ]
    const command =
      process.platform === 'linux'
        ? [
            'xvfb-run',
            '-a',
            '-s',
            '-screen 0 1280x800x24 -nolisten tcp',
            'dbus-run-session',
            '--',
            electron,
            ...args
          ]
        : [electron, ...args]
    app = spawn(command[0], command.slice(1), {
      cwd: repo,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    app.stdout?.on('data', (b: Buffer) => appendFileSync(appLog, b))
    app.stderr?.on('data', (b: Buffer) => appendFileSync(appLog, b))
    app.on('error', (e) => {
      appendFileSync(appLog, String(e))
    })
    if (
      !check(
        'one isolated instance published its socket',
        await until('instance socket', 120_000, () => existsSync(join(data, 'server.json')))
      )
    )
      throw new Error(`no server.json: ${appLog}`)
    const store = await rpc<{ skills: { name: string }[] }>('skills.list')
    if (
      !check(
        'before any CLI leg, the store excludes the home-only skill',
        !store.skills.some((s) => s.name === HOME_SKILL)
      )
    )
      throw new Error('negative control imported')
    await write(1)
    check('store probe reaches all three scope pointers', true)
    if (!binaries.claude) log('claude: required binary unresolved; its leg cannot judge')
    else {
      phase = 'claude'
      anthropic.script = [{ tool: skillCall(PROBE_SKILL) }, { text: 'gate claude one' }]
      let mark = claudeRequests.length
      const t = await start('claude', 'claude-haiku-5-5', join(work, 'claude'))
      const first = claudeRequests.slice(mark).find((r) => r.main)
      if (!first) throw new Error(`claude fake not accepted: ${errors(t.rows)}`)
      const listing = listingVerdict(skillListing(first.body, 'claude'))
      check(
        'claude: first listing names the bare store skill and excludes home-only',
        listing.probe && listing.bare && listing.homeAbsent,
        JSON.stringify(listing)
      )
      check(
        'claude: a Skill call brings N1 into the next provider request',
        claudeRequests.slice(mark + 1).some((r) => r.main && carriesNonce(r.body, word(1))),
        errors(t.rows)
      )
      const before = cli(t.id, 'claude')
      check(
        'claude: live CLI uses the owned scope config root',
        before?.env.get('CLAUDE_CONFIG_DIR') === join(data, 'harness/claude-config/global'),
        JSON.stringify(before)
      )
      await write(2)
      mark = claudeRequests.length
      anthropic.script = [{ tool: skillCall(PROBE_SKILL) }, { text: 'gate claude two' }]
      const second = await next(t.id)
      check(
        'claude: rewrite N2 reaches the same thread with its pid unchanged',
        bodyReached(claudeRequests, mark, 2) &&
          before !== undefined &&
          cli(t.id, 'claude')?.pid === before.pid,
        errors(second)
      )
      const waiting = await until(
        'warm Claude',
        45_000,
        async () => ((await warm())?.warm.length ?? 0) > 0
      )
      check('claude: a warm process waits', waiting, JSON.stringify(await warm()))
      const poolBefore = await warm()
      await write(3)
      mark = claudeRequests.length
      anthropic.script = [{ tool: skillCall(PROBE_SKILL) }, { text: 'gate claude three' }]
      const adopted = await start('claude', 'claude-haiku-5-5', join(work, 'claude'))
      const poolAfter = await warm()
      check(
        'claude: warm adoption rises without a miss',
        waiting &&
          (poolAfter?.adopted ?? 0) === (poolBefore?.adopted ?? 0) + 1 &&
          misses(poolAfter) === misses(poolBefore),
        `${JSON.stringify(poolBefore)} -> ${JSON.stringify(poolAfter)}`
      )
      check(
        'claude: the adopted process carries rewritten N3',
        bodyReached(claudeRequests, mark, 3),
        errors(adopted.rows)
      )
      judges.push('claude')
    }
    const catalog = await rpc<Record<string, { models?: { id: string }[] }>>('catalog.get')
    for (const provider of ['codex', 'muse'] as const) {
      phase = provider
      if (!binaries[provider]) {
        skip(`${provider}: binary missing from real login shell and fallback paths`)
        continue
      }
      const model = provider === 'codex' ? 'gpt-6-luna' : catalog.muse?.models?.[0]?.id
      if (!model) {
        skip(`${provider}: fake catalog supplied no model`)
        continue
      }
      await write(4)
      let mark = responseRequests.length
      const t = await start(provider, model, join(work, provider))
      const first = responseRequests.slice(mark).find((r) => r.main)
      if (!first) {
        skip(
          `${provider}: CLI did not accept fake turn: ${errors(t.rows) || 'no main provider request'}`
        )
        continue
      }
      const listing = listingVerdict(skillListing(first.body, provider))
      if (provider === 'muse') {
        check('muse: first request lists the store skill', listing.probe, JSON.stringify(listing))
        const gap = museHomeGap(first.body, home)
        console.log(gap.message)
        if (gap.fail) failures++
      } else {
        check(
          'codex: first request lists the store skill and excludes home-only',
          listing.probe && listing.homeAbsent,
          JSON.stringify(listing)
        )
      }
      const before = provider === 'codex' ? cli(t.id, 'codex') : undefined
      const disabled = homeFiles.filter((p) => /\/(?:\.codex|\.agents)\//.test(p))
      if (provider === 'codex')
        check(
          'codex: live app-server argv disables every home skill',
          before !== undefined &&
            disabled.every((p) => disabledSkillPaths(before.argv).includes(p)),
          JSON.stringify(before)
        )
      await write(5)
      mark = responseRequests.length
      // Responses CLIs read a skill via their shell; the fake asks for the materialized file.
      responses.script =
        provider === 'muse'
          ? [
              {
                tool: (tools) => {
                  const namespace = tools.find(
                    (t) => t.type === 'namespace' && t.tools?.some((x) => x.name === 'read_skill')
                  )
                  return namespace
                    ? {
                        name: 'read_skill',
                        namespace: namespace.name,
                        input: { name: PROBE_SKILL }
                      }
                    : null
                }
              },
              { text: 'gate rewrite' }
            ]
          : [
              {
                shell: (body) => {
                  const path = advertisedSkillFile(body)
                  return path?.startsWith(`${data}/harness/codex/`)
                    ? `cat -- '${path.replace(/'/g, "'\\''")}'`
                    : 'false'
                }
              },
              { text: 'gate rewrite' }
            ]
      const second = await next(t.id)
      check(
        `${provider}: N5 reaches the next call of the same thread`,
        bodyReached(responseRequests, mark, 5),
        errors(second)
      )
      if (provider === 'codex') {
        const late = join(home, '.codex/skills/tc-late-home/SKILL.md')
        put(late, md('tc-late-home', 'late negative control'))
        mark = responseRequests.length
        const third = await next(t.id),
          after = cli(t.id, 'codex')
        check(
          'codex: a new home skill reboots the app-server and disables it',
          before !== undefined &&
            after !== undefined &&
            after.pid !== before.pid &&
            [...disabled, late].every((p) => disabledSkillPaths(after.argv).includes(p)) &&
            responseRequests.length > mark,
          errors(third) || JSON.stringify(after)
        )
      }
      judges.push(provider)
    }
    check('harness.status names no skill set', !hasSkillSet(await rpc('harness.status')))
    log(`legs that judge: ${judges.join(', ') || 'none'}`)
  } catch (e) {
    if (binaries.claude && !judges.includes('claude'))
      claudeNotJudgedWhy = e instanceof Error ? e.message : String(e)
    check('gate completed', false, e instanceof Error ? e.message : String(e))
  } finally {
    await cleanup()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('exit', onExit)
  }
  const missingClaude = claudeJudgeFailure(judges, claudeNotJudgedWhy)
  if (missingClaude) check(missingClaude, false)
  // Include shutdown telemetry: the verdict comes only after every child has stopped.
  if (existsSync(join(root, 'denied.log')))
    denied.push(readFileSync(join(root, 'denied.log'), 'utf8'))
  check(
    'no provider or unapproved outbound request escaped the fakes',
    denied.length === 0,
    denied.join(' | ')
  )
  put(
    join(root, 'requests.json'),
    JSON.stringify(
      { anthropic: anthropic.requests, responses: responses.requests, denied, housekeeping },
      null,
      2
    )
  )
  check('nothing of the instance remains running', instanceProcesses(data).length === 0)
  console.log(
    `gate verdict: ${passes} PASS, ${failures} FAIL, ${skips} SKIP; judges: ${judges.join(', ') || 'none'}`
  )
  if (failures || process.env.TC_SD_KEEP === '1') log(`evidence kept: ${root}`)
  else rmSync(root, { recursive: true, force: true })
  return failures ? 1 : 0
}
