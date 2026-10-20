import { BrowserWindow, session } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_REDIRECT_URL, STATIC_SCOPES, type PlainCookie } from 'aliax-core'
import { providerUrl } from '../aliax'

/**
 * The browser half of a one-year token mint, in-app (T1). What `claude
 * setup-token` does in the system browser: Claude's consent page for the
 * Claude Code client, PKCE, and the authorization code on the callback;
 * the lifetime is asked for in the token exchange (aliax-core mint.ts),
 * nothing in this URL differs from an ordinary sign-in but the scope.
 *
 * The window runs in a throwaway partition seeded with the account's STORED
 * claude.ai session (the cookies login.ts files as `appSession`), so a live
 * session approves without anyone signing in: eleven accounts, no eleven
 * sign-outs. Hidden runs (renewals, Convert all) never ask anyone anything:
 * a login page, or no code within the time, answers `needs-sign-in` and the
 * caller decides whether to show a window. A visible run is the ordinary
 * in-app sign-in with the address pre-filled; closing it answers `closed`.
 */

export interface SessionMintInput {
  /** The account's stored claude.ai cookies; none means a sign-in is needed. */
  cookies: PlainCookie[] | null
  scopes?: string[]
  loginHint?: string
  /** Show the window (the user asked and will sign in); hidden runs decide on their own. */
  visible: boolean
  /** Hidden runs give up after this; a visible run waits for the user. */
  timeoutMs?: number
  /** Test seam: the consent page's approve button, clicked once per page when present. */
  consentSelector?: string
}

export type SessionMintResult =
  | { kind: 'code'; code: string; state: string; verifier: string; redirectUri: string; scopes: string[]; cookies: PlainCookie[] }
  | { kind: 'needs-sign-in'; detail: string }
  | { kind: 'closed' }

export const HIDDEN_MINT_TIMEOUT_MS = 45_000
/** Match the landing page by path, never by host: the host moved once and broke sign-in (claude-web-login.ts). */
const CALLBACK_PATHS = ['/oauth/code/callback', '/oauth/code/success']
const LOGIN_PATHS = ['/login', '/signin', '/sign-in', '/magic-link']
/** The cookies that carry the claude.ai login (claude-web-login.ts). */
const SESSION_COOKIES = ['sessionKey', 'sessionKeyLC', 'lastActiveOrg', 'anthropic-device-id']
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** The consent page's approve button, by its label; nothing is guessed when no label matches. */
export const CONSENT_SCRIPT = `(() => {
  const labels = /^(authori[sz]e|allow|approve|accept|continue)$/i
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
  const hit = buttons.find((b) => labels.test((b.innerText || b.value || '').trim()))
  if (!hit) return false
  hit.click()
  return true
})()`

export function codeFrom(target: string): { code: string; state: string | null } | null {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return null
  }
  if (!CALLBACK_PATHS.some((p) => url.pathname.startsWith(p))) return null
  const code = url.searchParams.get('code')
  return code ? { code, state: url.searchParams.get('state') } : null
}

/** A page that asks for a sign-in rather than for consent. */
export function isLoginPage(target: string): boolean {
  try {
    const url = new URL(target)
    return LOGIN_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`)) || url.searchParams.has('returnTo')
  } catch {
    return false
  }
}

export interface AuthorizeRequest {
  url: string
  verifier: string
  state: string
  redirectUri: string
  scopes: string[]
}

/** The consent URL for a one-year token: Claude Code's client, PKCE, the scopes asked for. */
export function authorizeRequest(scopes: string[] = STATIC_SCOPES, loginHint?: string): AuthorizeRequest {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const url = new URL(providerUrl(CLAUDE_AUTHORIZE_URL))
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URL)
  url.searchParams.set('scope', scopes.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (loginHint) url.searchParams.set('login_hint', loginHint)
  return { url: url.toString(), verifier, state, redirectUri: CLAUDE_REDIRECT_URL, scopes }
}

/** Cookie records for Electron's jar, against the origin the consent page is served from. */
export function cookieRecords(cookies: PlainCookie[], origin: string): Electron.CookiesSetDetails[] {
  const host = new URL(origin).hostname
  const claude = host === 'claude.ai' || host.endsWith('.claude.ai')
  return cookies.map((c) => ({
    url: origin,
    name: c.name,
    value: c.value,
    // A stored domain is claude.ai's; against a stand-in origin the cookie is host-only.
    ...(claude && c.domain ? { domain: c.domain } : {}),
    path: c.path ?? '/',
    secure: claude ? (c.secure ?? true) : false,
    httpOnly: c.httpOnly ?? false,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite as Electron.CookiesSetDetails['sameSite']
  }))
}

let open: BrowserWindow | null = null

/** Close a mint window left open (the user cancelled from the page). */
export function closeMintWindow(): void {
  if (open && !open.isDestroyed()) open.destroy()
  open = null
}

export async function mintInWindow(input: SessionMintInput): Promise<SessionMintResult> {
  const req = authorizeRequest(input.scopes ?? STATIC_SCOPES, input.loginHint)
  const origin = new URL(req.url).origin
  const partition = `aliax-claude-mint-${randomBytes(8).toString('hex')}`
  const ses = session.fromPartition(partition)
  ses.setUserAgent(BROWSER_UA)
  for (const record of cookieRecords(input.cookies ?? [], origin)) {
    await ses.cookies.set(record).catch(() => {})
  }
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    show: input.visible,
    title: 'Sign in to Claude',
    autoHideMenuBar: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true }
  })
  win.webContents.setUserAgent(BROWSER_UA)
  if (input.visible) open = win

  const readSession = async (): Promise<PlainCookie[]> => {
    const all = await ses.cookies.get({ url: origin }).catch(() => [])
    return all
      .filter((c) => SESSION_COOKIES.includes(c.name))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '.claude.ai',
        path: c.path ?? '/',
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite
      }))
  }

  return new Promise<SessionMintResult>((resolve) => {
    let settled = false
    const done = (value: SessionMintResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
      if (open === win) open = null
      if (!win.isDestroyed()) win.destroy()
      // The jar held a live session; nothing of it outlives the mint.
      void ses.clearStorageData().catch(() => {})
    }
    const timer = input.visible
      ? undefined
      : setTimeout(() => done({ kind: 'needs-sign-in', detail: 'the consent page did not answer in time' }), input.timeoutMs ?? HIDDEN_MINT_TIMEOUT_MS)

    const onNavigate = async (target: string): Promise<void> => {
      const hit = codeFrom(target)
      if (hit) {
        done({ kind: 'code', code: hit.code, state: hit.state ?? req.state, verifier: req.verifier, redirectUri: req.redirectUri, scopes: req.scopes, cookies: await readSession() })
        return
      }
      // A hidden run that lands on a sign-in page has no session to approve with.
      if (!input.visible && isLoginPage(target)) done({ kind: 'needs-sign-in', detail: 'the stored claude.ai session has lapsed' })
    }
    win.webContents.on('will-redirect', (_e, target) => void onNavigate(target))
    win.webContents.on('did-navigate', (_e, target) => void onNavigate(target))
    win.webContents.on('did-navigate-in-page', (_e, target) => void onNavigate(target))
    win.webContents.on('did-finish-load', () => {
      const here = win.webContents.getURL()
      void onNavigate(here)
      if (settled || codeFrom(here) || isLoginPage(here)) return
      // The consent page: approve it, the way the user would. Only a button
      // whose label says so is clicked, and only once per page.
      void win.webContents.executeJavaScript(input.consentSelector ? `(() => { const b = document.querySelector(${JSON.stringify(input.consentSelector)}); if (!b) return false; b.click(); return true })()` : CONSENT_SCRIPT, true).catch(() => false)
    })
    win.on('closed', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (open === win) open = null
      resolve(input.visible ? { kind: 'closed' } : { kind: 'needs-sign-in', detail: 'the window closed before a code arrived' })
    })
    win.loadURL(req.url).catch((err: Error) => done({ kind: 'needs-sign-in', detail: `the consent page did not load (${err.message})` }))
  })
}
