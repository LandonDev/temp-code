import { spawn as forkPty, type IPty } from 'node-pty'
import { homedir } from 'node:os'
import { harnessEnv, resolveClaude } from '../server/drivers/binaries'

/**
 * `claude setup-token`, run for the user (thread V). The CLI opens the
 * browser itself, waits for the approval, and prints a long-lived bearer
 * ("Your OAuth token (valid for 1 year): sk-ant-oat01-…"). It renders with
 * Ink, which needs a tty, so it runs in a pty whose output is parsed. The
 * token is inference-only: it cannot ask the profile endpoint who it
 * belongs to, so the caller names the account.
 */
export interface SetupTokenResult {
  token: string
  /** When the CLI says the token lapses; a year from now when it says nothing. */
  expiresAt: number
  validFor: string | null
}

export const SETUP_TOKEN_TIMEOUT_MS = 10 * 60_000
const YEAR_MS = 365 * 86_400_000
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/
const VALID_RE = /valid for ([^)\n]+)\)/
// CSI, OSC and charset-select sequences; Ink repaints the screen with them.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r/g

/** "1 year", "365 days", "2 months", "12 hours" → ms; null when unreadable. */
export function parseValidFor(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute)s?/i.exec(text)
  if (!m) return null
  const n = Number(m[1])
  const unit = { year: YEAR_MS, month: 30 * 86_400_000, week: 7 * 86_400_000, day: 86_400_000, hour: 3_600_000, minute: 60_000 }[m[2].toLowerCase()]
  return unit === undefined || !Number.isFinite(n) ? null : Math.round(n * unit)
}

export function parseSetupTokenOutput(raw: string): { token: string | null; validFor: string | null } {
  const text = raw.replace(ANSI_RE, '')
  return { token: TOKEN_RE.exec(text)?.[0] ?? null, validFor: VALID_RE.exec(text)?.[1]?.trim() ?? null }
}

let current: IPty | null = null

export async function runSetupToken(): Promise<SetupTokenResult> {
  if (current) throw new Error('a setup-token run is already in progress')
  const { path } = await resolveClaude()
  if (!path) throw new Error('the claude CLI is not installed on this machine; install it to mint a token')
  const base = await harnessEnv()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  env.TERM = 'xterm-256color'
  env.HOME ??= homedir()
  // The user's own sign-in, never through the gateway, never with a token already in the air.
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_API_KEY
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  const pty = forkPty(path, ['setup-token'], { name: 'xterm-256color', cols: 220, rows: 50, cwd: homedir(), env })
  current = pty
  let raw = ''
  return new Promise<SetupTokenResult>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (current === pty) current = null
      fn()
    }
    const timer = setTimeout(() => {
      pty.kill()
      finish(() => reject(new Error('claude setup-token did not finish within 10 minutes')))
    }, SETUP_TOKEN_TIMEOUT_MS)
    const settle = (exitCode: number | null): void => {
      const { token, validFor } = parseSetupTokenOutput(raw)
      if (token) {
        const validMs = validFor ? parseValidFor(validFor) : null
        finish(() => resolve({ token, validFor, expiresAt: Date.now() + (validMs ?? YEAR_MS) }))
        return
      }
      // No token in the output, so nothing secret in it either; the tail says why.
      const tail = raw.replace(ANSI_RE, '').trim().split('\n').filter(Boolean).slice(-4).join(' · ')
      finish(() => reject(new Error(exitCode === 0 ? `claude setup-token printed no token${tail ? ` (${tail})` : ''}` : `claude setup-token failed${tail ? `: ${tail}` : ''}`)))
    }
    pty.onData((data) => {
      raw += data
    })
    pty.onExit(({ exitCode }) => setTimeout(() => settle(exitCode), 50))
  })
}

export function cancelSetupToken(): void {
  const pty = current
  current = null
  pty?.kill()
}
