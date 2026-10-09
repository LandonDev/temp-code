import { net, shell } from 'electron'
import { claudeWebLogin } from './claude-web-login'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, decodeJwtPayload, type Captured } from 'aliax-core'

const exec = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

// ---- Claude: Claude Code's own public OAuth client, manual-code variant ----

/**
 * The whole Claude sign-in: one window, both halves, nothing to paste.
 *
 * It deliberately does NOT use the default browser. Signing in there would
 * inherit an existing Google session, but the claude.ai cookies would stay in
 * that browser — and those cookies are the only reliable app half, because the
 * Claude desktop app rotates its own session and flushes it to disk only on
 * quit (invariant 9). This window mints a fresh, valid one instead. Its cookie
 * jar persists, so the Google login is a one-time cost and later adds get the
 * account chooser.
 *
 * Returns null when the user closes the window without approving.
 */
export async function claudeSignIn(loginHint?: string): Promise<Captured | null> {
  const result = await claudeWebLogin(loginHint)
  if (!result) return null

  const res = await net.fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: result.code,
      state: result.state,
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: result.redirectUri,
      code_verifier: result.verifier
    })
  })
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`)

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    scope?: string
    account?: { uuid?: string; email_address?: string }
    organization?: { uuid?: string; name?: string }
  }
  const accountId = data.account?.uuid
  if (!accountId) throw new Error('no account in token response')

  const keychain = JSON.stringify({
    claudeAiOauth: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: data.scope?.split(' ') ?? ['org:create_api_key', 'user:profile', 'user:inference']
    }
  })
  const oauthAccount = {
    accountUuid: accountId,
    emailAddress: data.account?.email_address,
    organizationUuid: data.organization?.uuid,
    organizationName: data.organization?.name
  }
  const hasApp = result.cookies.some((c) => c.name === 'sessionKey')
  return {
    accountId,
    email: data.account?.email_address,
    note: hasApp ? 'CLI and app both linked' : 'app half missing. Sign in again through Aliax',
    blob: JSON.stringify({ keychain, oauthAccount, appSession: hasApp ? result.cookies : null })
  }
}

export function claudeLoginCancel(): void {
  // the sign-in window owns cancellation; closing it resolves the flow
}

// ---- Cursor: deep-link login with server-side polling ----

let cursorCancelled = false

export async function cursorLogin(): Promise<Captured> {
  const { verifier, challenge } = pkce()
  const uuid = randomUUID()
  cursorCancelled = false
  await shell.openExternal(
    `https://www.cursor.com/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login`
  )

  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    if (cursorCancelled) throw new Error('cancelled')
    await sleep(2000)
    const res = await net.fetch(
      `https://api2.cursor.sh/auth/poll?uuid=${uuid}&verifier=${verifier}`
    ).catch(() => null)
    if (!res?.ok) continue
    const data = (await res.json()) as { accessToken?: string; refreshToken?: string }
    if (!data.accessToken || !data.refreshToken) continue

    const sub = decodeJwtPayload(data.accessToken).sub
    if (typeof sub !== 'string') throw new Error('unexpected token from Cursor')
    const email = await fetchCursorEmail(sub, data.accessToken)
    const vscdb: Record<string, string> = {
      'cursorAuth/accessToken': data.accessToken,
      'cursorAuth/refreshToken': data.refreshToken,
      'cursorAuth/cachedSignUpType': 'AuthZero'
    }
    if (email) vscdb['cursorAuth/cachedEmail'] = email
    return {
      accountId: sub,
      email,
      blob: JSON.stringify({ access: data.accessToken, refresh: data.refreshToken, vscdb })
    }
  }
  throw new Error('timed out waiting for browser sign-in')
}

async function fetchCursorEmail(sub: string, access: string): Promise<string | undefined> {
  const res = await net.fetch('https://cursor.com/api/auth/me', {
    headers: { Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${sub}::${access}`)}` }
  }).catch(() => null)
  if (!res?.ok) return undefined
  const me = (await res.json()) as { email?: string }
  return me.email
}

export function cursorLoginCancel(): void {
  cursorCancelled = true
}

// ---- Codex: the official CLI owns the flow; we just run it ----

let codexChild: ChildProcess | null = null

/** Last stdout line from a login shell, so profile noise can't pollute it. */
async function loginShell(cmd: string): Promise<string> {
  const { stdout } = await exec('/bin/zsh', ['-lc', cmd])
  return stdout.trim().split('\n').pop() ?? ''
}

export async function codexLogin(): Promise<void> {
  // `whence -p`, not `which`: our own shell integration wraps codex in a
  // function, and `which` prints that function's body instead of a path.
  const bin = await loginShell('whence -p codex || true')
  if (!bin) throw new Error('codex CLI not found')
  // The npm/Homebrew `codex` is a node script (`#!/usr/bin/env node`). A GUI
  // app's PATH has no node, so spawning with our own environment made env fail
  // with the bare "exited 127". Hand it the login shell's PATH instead.
  const PATH = await loginShell('echo "$PATH"')
  await new Promise<void>((resolve, reject) => {
    codexChild = spawn(bin, ['login'], { stdio: 'ignore', env: { ...process.env, PATH } })
    codexChild.on('error', reject)
    codexChild.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(code === null ? 'cancelled' : `codex login exited ${code}`))
    )
  })
  codexChild = null
}

export function codexLoginCancel(): void {
  codexChild?.kill()
  codexChild = null
}
