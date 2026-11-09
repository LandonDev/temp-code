#!/usr/bin/env bun
/**
 * The config-dir spike: how the skills store can point Claude Code, Codex and
 * Muse at a directory the app owns. One registry of experiments (C* Claude,
 * X* Codex, M* Muse; scripts/lib/spike{Claude,Codex,Muse}.ts), each in its
 * own tree under `$TMPDIR/tc-config-spike/<run>/<id>/` with a temp HOME, each
 * writing one evidence file `scripts/.out/config-dir-spike/<host>/<id>.json`
 * through redactEvidence (scripts/lib/configDirSpike.ts). Every run talks to
 * a loopback fake with placeholder credentials unless it is a real half
 * (`--upstream`, the Mac leg against an isolated dev instance's gateway).
 * The findings live in .temp-code/findings/claude-config-dir.md.
 *
 *   bun run script:spike-config-dirs -- --host box
 *   bun run script:spike-config-dirs -- --host mac --upstream --dev-user-data <dir>
 *
 * Flags: --host mac|box, --harness claude,codex,muse, --only C1a,X3,
 * --upstream, --dev-user-data <dir>, --claude-account <name>,
 * --codex-account <name>, --claude <path>, --keep (leave the temp trees, less
 * any login file that is not a placeholder).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCertificate } from '../src/main/server/tls'
import { findSecrets, placeholderClaudeCredentials, placeholderCodexAuth, placeholderMuseAuth, redactEvidence } from './lib/configDirSpike'
import { claudeExperiments, claudeVersionsAtEnd } from './lib/spikeClaude'
import { codexExperiments } from './lib/spikeCodex'
import { compareVersions, ctx, errText, firstLine, loginPath, setCtx, which, type Ctx, type Dev, type Evidence } from './lib/spikeContext'
import { FakeAnthropic, FakeResponses, PROBE_MCP_SOURCE, killChildren, run, within } from './lib/spikeFakes'
import { loadMuseModels, museExperiments } from './lib/spikeMuse'

const REPO = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? '') : null
}
const has = (name: string): boolean => args.includes(`--${name}`)

process.on('unhandledRejection', (e) => console.log(`      (unhandled: ${errText(e)})`))

const host = flag('host') ?? (process.platform === 'darwin' ? 'mac' : 'box')
const harnesses = new Set((flag('harness') ?? 'claude,codex,muse').split(',').map((s) => s.trim()))
const only = flag('only')?.split(',').map((s) => s.trim()) ?? null
const upstream = has('upstream')
const devDir = flag('dev-user-data')
if (upstream && !devDir) {
  console.error('--upstream needs --dev-user-data <dir> (an isolated dev instance)')
  process.exit(2)
}
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${host}`
const root = join(process.env.TMPDIR || tmpdir(), 'tc-config-spike', runId)
const out = join(REPO, 'scripts', '.out', 'config-dir-spike', host)
mkdirSync(root, { recursive: true })
mkdirSync(out, { recursive: true })

// ── the dev instance (real halves) ───────────────────────────────────────────

/** Strings the evidence must not carry: the dev instance's account names, raw and encoded. */
const scrub: string[] = []

async function openDev(dir: string): Promise<Dev> {
  const { port } = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error('the dev socket failed')))
  })
  const pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
  let n = 0
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(String(e.data)) as { id?: string; ok?: boolean; result?: unknown; error?: unknown }
    if (typeof f.id === 'string' && pending.has(f.id)) {
      const p = pending.get(f.id)!
      pending.delete(f.id)
      if (f.ok) p.ok(f.result)
      else p.bad(new Error(String(f.error)))
    }
  })
  const req = <T>(method: string): Promise<T> =>
    within(
      new Promise<T>((ok, bad) => {
        const id = `spike${++n}`
        pending.set(id, { ok: ok as (v: unknown) => void, bad })
        ws.send(JSON.stringify({ id, method, params: {} }))
      }),
      20_000,
      method
    )
  try {
    const doctor = await req<{ gateway?: { port?: number } }>('doctor.get')
    type Profile = { name: string; static?: boolean; kind?: string; expired?: boolean }
    const accounts = await req<{ providers?: Record<string, { profiles?: Profile[]; pinned?: string | null }> }>('accounts.list')
    const profiles = (p: string): Profile[] => accounts.providers?.[p]?.profiles ?? []
    const pick = (p: string): string | null =>
      (profiles(p).find((x) => !x.expired && (x.static || x.kind === 'static')) ?? profiles(p).find((x) => x.name === accounts.providers?.[p]?.pinned) ?? profiles(p).find((x) => !x.expired) ?? profiles(p)[0])?.name ?? null
    for (const p of ['claude', 'codex']) {
      console.log(`dev ${p} accounts:`)
      for (const x of profiles(p)) console.log(`  ${x.name}${x.static || x.kind === 'static' ? ' (one-year token)' : ''}${x.expired ? ' (expired)' : ''}`)
      for (const x of profiles(p)) scrub.push(x.name, encodeURIComponent(x.name))
    }
    if (!doctor.gateway?.port) throw new Error('doctor.get named no gateway port')
    return { gatewayPort: doctor.gateway.port, claudeAccount: pick('claude'), codexAccount: pick('codex'), claudeAccounts: profiles('claude').length, codexAccounts: profiles('codex').length }
  } finally {
    ws.close()
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

const lp = await loginPath()
const sdkPkg = JSON.parse(readFileSync(join(REPO, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion?: string }
const bundled = join(REPO, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude')
const anth = await new FakeAnthropic().start()
const tlsDir = join(root, 'tls')
await makeCertificate(tlsDir, 'TC Config Spike CA')
const codexFront = await new FakeResponses({ cert: readFileSync(join(tlsDir, 'cert.pem')), key: readFileSync(join(tlsDir, 'key.pem')) }).start()
const museFront = await new FakeResponses(null).start()
const museModelsPath = join(REPO, 'scripts', 'lib', 'fixtures', 'muse-models.json')
museFront.museModels = loadMuseModels(museModelsPath)
const mcpScript = join(root, 'probe-mcp.mjs')
writeFileSync(mcpScript, PROBE_MCP_SOURCE)

const c: Ctx = {
  host,
  run: runId,
  root,
  out,
  repo: REPO,
  upstream,
  loginPath: lp,
  claude: { login: null, loginVersion: null, bundled: existsSync(bundled) ? bundled : null, bundledVersion: sdkPkg.claudeCodeVersion ?? null, choice: null, choiceVersion: null },
  codexBin: null,
  museBin: null,
  anth,
  codexFront,
  museFront,
  caPath: join(tlsDir, 'ca.pem'),
  mcpScript,
  dev: null,
  claudeAccountOverride: flag('claude-account'),
  codexAccountOverride: flag('codex-account'),
  specs: {},
  codexHomes: {},
  codexAccepted: null,
  museAccepted: null,
  codexModel: null,
  museModelsPath
}
setCtx(c)

const version = async (bin: string | null): Promise<string | null> => {
  if (!bin) return null
  const r = await run(bin, ['--version'], { env: { ...process.env, PATH: lp }, timeoutMs: 60_000 })
  return r.code === 0 ? firstLine(r.stdout) : null
}
c.claude.login = flag('claude') ?? (await which('claude'))
c.claude.loginVersion = await version(c.claude.login)
const loginNewer = !!c.claude.loginVersion && (!c.claude.bundledVersion || compareVersions(c.claude.loginVersion, c.claude.bundledVersion) > 0)
c.claude.choice = flag('claude') ?? (loginNewer ? c.claude.login : null)
c.claude.choiceVersion = c.claude.choice ? c.claude.loginVersion : c.claude.bundledVersion
c.codexBin = await which('codex')
c.museBin = await which('muse')
if (devDir) c.dev = await openDev(devDir)
for (const name of [c.claudeAccountOverride, c.codexAccountOverride]) if (name) scrub.push(name, encodeURIComponent(name))

console.log(`run ${runId}`)
console.log(`claude ${c.claude.choiceVersion ?? '-'} (${c.claude.choice ? 'login PATH' : 'bundled'}), codex ${c.codexBin ? 'found' : 'missing'}, muse ${c.museBin ? 'found' : 'missing'}${c.dev ? `, dev gateway :${c.dev.gatewayPort}` : ''}`)
console.log(`evidence → ${out}\n`)

// ── run ──────────────────────────────────────────────────────────────────────

const registry = [...(harnesses.has('claude') ? claudeExperiments() : []), ...(harnesses.has('codex') ? codexExperiments() : []), ...(harnesses.has('muse') ? museExperiments() : [])]
const selected = only ? registry.filter((e) => only.includes(e.id)) : registry

function writeEvidence(ev: Evidence): void {
  let text = JSON.stringify(redactEvidence(ev), null, 2)
  for (const s of scrub.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(s).join('<account>')
  writeFileSync(join(out, `${ev.id}.json`), `${text}\n`)
}

const evidences: Evidence[] = []
for (const e of selected) {
  const ev: Evidence = { id: e.id, harness: e.harness, host, title: e.title, at: new Date().toISOString(), cli: null, env: {}, unset: [], argv: null, commands: [], observed: {}, status: 'error', verdict: '' }
  const t0 = Date.now()
  process.stdout.write(`${e.id.padEnd(4)} ${e.title} ... `)
  try {
    await within(e.run(ev), 10 * 60_000, e.id)
  } catch (err) {
    ev.status = 'error'
    ev.verdict = `crashed: ${errText(err)}`
    ev.observed.crash = { message: errText(err), at: String((err as Error)?.stack ?? '').split('\n').slice(1, 4).map((s) => s.trim()) }
  }
  ev.observed.ms = Date.now() - t0
  console.log(`${ev.status}: ${ev.verdict}`)
  writeEvidence(ev)
  evidences.push(ev)
  await killChildren()
}

// C0 again: a CLI that updated mid-run.
const c0 = evidences.find((x) => x.id === 'C0')
if (c0) {
  const end = await claudeVersionsAtEnd()
  c0.observed.atEnd = end
  if (end.login !== c.claude.loginVersion) c0.verdict += `; the login CLI changed mid-run to ${end.login}`
  writeEvidence(c0)
}

// ── summary, the secret sweep, cleanup ───────────────────────────────────────

const rows = evidences.map((x) => ({ id: x.id, status: x.status, verdict: x.verdict }))
writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ run: runId, host, at: new Date().toISOString(), rows }, null, 2)}\n`)
console.log(`\n${'id'.padEnd(5)}${'status'.padEnd(9)}verdict`)
for (const r of rows) console.log(`${r.id.padEnd(5)}${r.status.padEnd(9)}${r.verdict}`)

let secrets = 0
for (const f of [...readdirSync(out).map((x) => join(out, x)), museModelsPath].filter((p) => existsSync(p) && statSync(p).isFile())) {
  const found = findSecrets(readFileSync(f, 'utf8'))
  if (found.length) {
    secrets += found.length
    console.log(`SECRET SWEEP: ${f}: ${found.map((x) => `${x.kind}@${x.at}`).join(', ')}`)
  }
}
console.log(secrets ? `\n${secrets} possible secret(s) in the evidence: commit nothing until they are gone` : '\nsecret sweep: clean')

await killChildren()
await killByMarker(runId)
anth.close()
codexFront.close()
museFront.close()
if (has('keep')) sanitize(root)
else rmSync(root, { recursive: true, force: true })
process.exit(secrets ? 3 : 0)

/** Whatever this run started that outlived its owner (a muse serve the SDK owns, an MCP server), by its marker. */
async function killByMarker(marker: string): Promise<void> {
  const needle = `TC_SPIKE_RUN=${marker}`
  const pids: number[] = []
  if (existsSync('/proc')) {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(needle)) pids.push(Number(entry))
      } catch {
        // gone or not ours
      }
    }
  } else {
    const r = await run('ps', ['axeww', '-o', 'pid=,command='], { timeoutMs: 15_000 })
    for (const line of r.stdout.split('\n')) if (line.includes(needle)) pids.push(Number(line.trim().split(/\s+/)[0]))
  }
  for (const pid of pids.filter((p) => p && p !== process.pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
}

/** --keep: drop every login file that is not one of the probe's placeholders. */
function sanitize(dir: string): void {
  const placeholders = new Set([placeholderClaudeCredentials(), placeholderCodexAuth(), placeholderMuseAuth()])
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) walk(p)
      else if (/^(\.credentials\.json|auth\.json)$/.test(name) && !placeholders.has(readFileSync(p, 'utf8'))) rmSync(p, { force: true })
    }
  }
  walk(dir)
  console.log(`kept ${dir}`)
}

export { ctx }
