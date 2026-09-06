import { execFile } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeUsageFetch } from '@shared/contract-m3a'

const execFileP = promisify(execFile)
const SERVICE = 'Claude Code-credentials'
const USER_AGENT = 'claude-code/2.1.0'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
type JsonObject = Record<string, unknown>
interface Credentials {
  blob: JsonObject
  oauth: JsonObject
  accessToken: string
  refreshToken: string
  expiresAt: number | null
}
export interface UsageDependencies {
  fetch: typeof fetch
  security: (args: string[]) => Promise<string | null>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, value: string) => Promise<void>
  platform: string
  home: string
  user: string
  now: () => number
}
const defaults: UsageDependencies = {
  fetch: (input, init) => fetch(input, init),
  security: async (args) => {
    try {
      return (
        await execFileP('/usr/bin/security', args, { timeout: 5_000, maxBuffer: 1024 * 1024 })
      ).stdout.trim()
    } catch {
      return null
    } // Child errors contain argv, which may contain credentials.
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, value) => {
    await writeFile(path, value, { mode: 0o600 })
    await chmod(path, 0o600)
  },
  platform: process.platform,
  home: homedir(),
  user: process.env.USER ?? process.env.USERNAME ?? '',
  now: Date.now
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}
export function parseCredentials(raw: string): Credentials | null {
  try {
    const blob: unknown = JSON.parse(raw)
    if (!object(blob)) return null
    const oauth = object(blob.claudeAiOauth) ? blob.claudeAiOauth : blob
    const accessToken = text(oauth.accessToken ?? blob.accessToken)
    if (!accessToken) return null
    return {
      blob,
      oauth,
      accessToken,
      refreshToken: text(oauth.refreshToken ?? blob.refreshToken) ?? '',
      expiresAt: number(oauth.expiresAt ?? blob.expiresAt)
    }
  } catch {
    return null
  }
}
export function tokenNeedsRefresh(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && now + 5 * 60_000 >= expiresAt
}

function result(
  status: ClaudeUsageFetch['status'],
  httpStatus: number | null,
  body: string | null,
  error: string | null
): ClaudeUsageFetch {
  return { status, httpStatus, body, error }
}

export class ClaudeUsage {
  private deps: UsageDependencies
  private pending: Promise<ClaudeUsageFetch> | null = null
  constructor(deps: Partial<UsageDependencies> = {}) {
    this.deps = { ...defaults, ...deps }
  }

  fetch(): Promise<ClaudeUsageFetch> {
    // A refresh token may rotate. Concurrent callers must share one refresh.
    this.pending ??= this.run()
      .catch(() => result('error', null, null, 'Claude usage request failed'))
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  private async load(): Promise<{
    credentials: Credentials
    save: (raw: string) => Promise<void>
  } | null> {
    const d = this.deps
    if (d.platform === 'darwin') {
      const user = /^[A-Za-z0-9._-]+$/.test(d.user) ? d.user : 'claude-code-user'
      const accounts = [...new Set([user, 'claude-code-user'])]
      // The service-only lookup covers older/custom account names. Read its
      // metadata first so refreshed JSON goes back to the same account.
      const metadata = await d.security(['find-generic-password', '-s', SERVICE])
      const account = metadata?.match(/"acct"<blob>="([^"\n]+)"/)?.[1]
      if (account && !accounts.includes(account)) accounts.push(account)
      for (const account of accounts) {
        const raw = await d.security(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
        const credentials = raw ? parseCredentials(raw) : null
        if (!credentials) continue
        return {
          credentials,
          save: async (value) => {
            if (
              (await d.security([
                'add-generic-password',
                '-U',
                '-s',
                SERVICE,
                '-a',
                account,
                '-w',
                value
              ])) === null
            )
              throw new Error('Credential write failed')
          }
        }
      }
    }
    const path = join(d.home, '.claude', '.credentials.json')
    try {
      const credentials = parseCredentials(await d.readFile(path))
      return credentials ? { credentials, save: (raw) => d.writeFile(path, raw) } : null
    } catch {
      return null
    }
  }

  private async run(): Promise<ClaudeUsageFetch> {
    const loaded = await this.load()
    if (!loaded) return result('unavailable', null, null, 'Claude not signed in')
    const { credentials: creds, save } = loaded
    const secrets = new Set([creds.accessToken, creds.refreshToken].filter(Boolean))
    const refresh = async (): Promise<boolean> => {
      if (!creds.refreshToken) return false
      try {
        const response = await this.deps.fetch(TOKEN_URL, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken,
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
          })
        })
        if (!response.ok) return false
        const payload: unknown = await response.json()
        if (!object(payload)) return false
        const access = text(payload.access_token)
        if (!access) return false
        creds.accessToken = access
        secrets.add(access)
        creds.oauth.accessToken = access
        const rotated = text(payload.refresh_token)
        if (rotated) {
          creds.refreshToken = rotated
          secrets.add(rotated)
          creds.oauth.refreshToken = rotated
        }
        for (const [source, target] of [
          ['expires_in', 'expiresAt'],
          ['refresh_token_expires_in', 'refreshTokenExpiresAt']
        ]) {
          const seconds = number(payload[source])
          if (seconds !== null) creds.oauth[target] = this.deps.now() + seconds * 1000
        }
        creds.expiresAt = number(creds.oauth.expiresAt)
        await save(JSON.stringify(creds.blob))
        return true
      } catch {
        return false
      }
    }
    const usage = async (): Promise<ClaudeUsageFetch> => {
      try {
        const response = await this.deps.fetch(USAGE_URL, {
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': USER_AGENT
          }
        })
        if (!response.ok) {
          const error =
            response.status === 401
              ? 'Claude sign-in expired'
              : response.status === 403
                ? 'Claude usage is unavailable for this account'
                : `Claude usage request failed (${response.status})`
          await response.body?.cancel()
          return result('error', response.status, null, error)
        }
        let body = await response.text()
        for (const secret of secrets) body = body.split(secret).join('[redacted]')
        return result('ok', response.status, body, null)
      } catch {
        return result('error', null, null, 'Claude usage request failed')
      }
    }
    if (tokenNeedsRefresh(creds.expiresAt, this.deps.now())) await refresh()
    const first = await usage()
    if (first.httpStatus !== 401 || !(await refresh())) return first
    return usage()
  }
}
