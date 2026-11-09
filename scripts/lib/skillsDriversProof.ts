/** Pure checks used by the unattended skills-drivers proof. */
export const PROBE_SKILL = 'tc-e2e-probe'
export const HOME_SKILL = 'tc-home-only'

/** Inspect the listing, apart from the user's prompt which also names the skill. */
export function skillListing(body: unknown, provider: 'claude' | 'codex' | 'muse'): string {
  const b = body as {
    tools?: unknown
    system?: unknown
    instructions?: unknown
    messages?: { content?: { type?: string; text?: string }[] }[]
    input?: { role?: string; content?: unknown }[]
  }
  if (provider === 'claude') {
    const reminders = (b.messages ?? [])
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .flatMap((c) => {
        const at =
          c.type === 'text'
            ? (c.text?.indexOf('The following skills are available for use with the Skill tool:') ??
              -1)
            : -1
        return at >= 0 ? [c.text!.slice(at)] : []
      })
    return JSON.stringify({ system: b.system, tools: b.tools, reminders })
  }
  return JSON.stringify({
    instructions: b.instructions,
    input: b.input?.filter((i) => i.role === 'developer' || i.role === 'system')
  })
}

export function listingVerdict(listing: string): {
  probe: boolean
  bare: boolean
  homeAbsent: boolean
} {
  return {
    probe: listing.includes(PROBE_SKILL),
    bare: listing.includes(PROBE_SKILL) && !new RegExp(`[\\w-]+:${PROBE_SKILL}`).test(listing),
    homeAbsent: !listing.includes(HOME_SKILL)
  }
}

/** Fresh requests are sliced at each turn, so history alone cannot pass a rewrite. */
export function carriesNonce(body: unknown, nonce: string): boolean {
  return JSON.stringify(body).includes(nonce)
}

/** Parse only the CLI's -c/--config pairs, never a matching word elsewhere in argv. */
export function disabledSkillPaths(argv: readonly string[]): string[] {
  const paths = new Set<string>()
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c' && argv[i] !== '--config') continue
    const value = argv[++i]
    if (!/^skills\.config\s*=\s*\[/.test(value)) continue
    for (const row of value.matchAll(
      /\{\s*path\s*=\s*("(?:\\.|[^"\\])*")\s*,\s*enabled\s*=\s*false\s*\}/g
    )) {
      try {
        paths.add(JSON.parse(row[1]) as string)
      } catch {
        /* malformed TOML is no proof */
      }
    }
  }
  return [...paths].sort()
}

/** ps on macOS omits shell quotes around argv; recover the single TOML config value. */
export function argvFromPs(command: string): string[] {
  return command.match(/skills\.config=\[(?:[^\]]|"(?:\\.|[^"\\])*")*\]|\S+/g) ?? []
}

export function isLoopbackTarget(target: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname)
  } catch {
    return false
  }
}

export function hasSkillSet(status: {
  environments: { sets: Record<string, unknown> | null }[]
}): boolean {
  return status.environments.some((e) => Object.keys(e.sets ?? {}).some((k) => /skills/i.test(k)))
}

/** Resolve the probe's own advertised path, including Codex's rN root aliases. */
export function advertisedSkillFile(body: unknown): string | null {
  const b = body as { input?: { role?: string; content?: { text?: string }[] }[] }
  const text = (b.input ?? [])
    .filter((i) => i.role === 'developer')
    .flatMap((i) => (Array.isArray(i.content) ? i.content.map((c) => c.text ?? '') : []))
    .join('\n')
  const file = [...text.matchAll(/\(file: ([^)]+\/tc-e2e-probe\/SKILL\.md)\)/g)].at(-1)?.[1]
  if (!file) return null
  if (file.startsWith('/')) return file
  const roots = new Map([...text.matchAll(/- `(r\d+)` = `([^`]+)`/g)].map((m) => [m[1], m[2]]))
  const [alias, ...rest] = file.split('/')
  return roots.has(alias) ? `${roots.get(alias)}/${rest.join('/')}` : null
}

/** The parent's accepted Muse gap must fail closed when the CLI stops exposing it. */
export function museHomeGap(
  body: unknown,
  home: string
): { ids: string[]; fail: boolean; message: string } {
  const b = body as { input?: { role?: string; content?: unknown }[] }
  const text = (b.input ?? [])
    .filter((i) => i.role === 'developer' || i.role === 'system')
    .flatMap((i) =>
      typeof i.content === 'string'
        ? [i.content]
        : Array.isArray(i.content)
          ? i.content.map((c) => (c as { text?: string }).text ?? '')
          : []
    )
    .join('\n')
  const ids = new Set<string>()
  for (const match of text.matchAll(/<skill\b([^>]*)>/g)) {
    const attrs = new Map([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
    const path = attrs.get('path') ?? ''
    const fromHome =
      path.startsWith('$CODEX_HOME/skills/') ||
      ['.agents', '.codex', '.claude'].some(
        (root) =>
          path.startsWith(`$HOME/${root}/skills/`) || path.startsWith(`${home}/${root}/skills/`)
      )
    if (fromHome && attrs.has('id')) ids.add(attrs.get('id')!)
  }
  const sorted = [...ids].sort()
  return {
    ids: sorted,
    fail: sorted.length === 0,
    message: sorted.length
      ? `KNOWN GAP  muse: lists home skills of other harnesses (${sorted.join(', ')}); a host fix is pending`
      : 'KNOWN GAP CLOSED  muse no longer lists home skills: make this check strict'
  }
}

/**
 * Chromium's network service still fetches Hunspell dictionaries from Google's
 * download CDN with component/background updates disabled. This exact host
 * carries no model traffic. Its CONNECT remains refused; only its verdict is
 * exempt. No provider hostname or other process may use the exception.
 */
export function isHousekeepingConnect(authority: string, argv: readonly string[]): boolean {
  return (
    authority.toLowerCase() === 'redirector.gvt1.com:443' &&
    argv.includes('--utility-sub-type=network.mojom.NetworkService')
  )
}

/**
 * The rig's stop signals stay handled until its cleanup is done: in a gate
 * step the runtime child shares the step's process group, so a group SIGTERM
 * and the Bun wrapper's forwarded one both arrive, and a one-shot handler
 * would leave the second to kill the rig mid-cleanup with its instances
 * still running. `cleanup` must be idempotent; `exit` runs once it settles.
 */
export function stopOnSignals(
  events: Pick<NodeJS.EventEmitter, 'on'>,
  cleanup: () => Promise<void>,
  exit: (code: number) => void
): void {
  const onSignal = (): void => void cleanup().then(() => exit(130))
  events.on('SIGINT', onSignal)
  events.on('SIGTERM', onSignal)
}
