import { BrowserWindow, session } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { CLAUDE_CLIENT_ID, type PlainCookie } from 'aliax-core'

/**
 * Anthropic moved this page from console.anthropic.com to platform.claude.com;
 * the old host no longer appears in Claude Code's CLI at all. Keep it in step
 * with whatever the CLI sends, since the same OAuth client validates it.
 */
const CLAUDE_REDIRECT = 'https://platform.claude.com/oauth/code/callback'
/**
 * Match the landing page by PATH, not by full URL. Pinning the host is what
 * broke sign-in when it moved: the code arrived, the prefix test failed, and the
 * window sat on "Waiting for sign-in" forever.
 */
const CALLBACK_PATHS = ['/oauth/code/callback', '/oauth/code/success']

function codeFrom(target: string): { code: string; state: string | null } | null {
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
/** Cookies that carry the claude.ai login; the rest is analytics noise. */
const SESSION_COOKIES = ['sessionKey', 'sessionKeyLC', 'lastActiveOrg', 'anthropic-device-id']
/** A real browser UA: Google refuses sign-in from anything it detects as an embedded view. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** One shared partition so a Google sign-in is remembered for later adds. */
const LOGIN_PARTITION = 'persist:aliax-claude-login'

export interface WebLoginResult {
  /** Authorization code for the CLI half. */
  code: string
  state: string
  verifier: string
  /** The redirect the code was issued for; the token exchange must repeat it. */
  redirectUri: string
  /** claude.ai session cookies for the app half; empty from the browser flow. */
  cookies: PlainCookie[]
}

/**
 * One sign-in that yields both halves of an account. The window loads Claude's
 * OAuth consent page: signing in happens on claude.ai (giving us its session
 * cookies) and approving redirects with the authorization code (giving us the
 * CLI tokens). No second browser trip and nothing to paste.
 */
export async function claudeWebLogin(loginHint?: string): Promise<WebLoginResult | null> {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  const url = new URL('https://claude.ai/oauth/authorize')
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT)
  url.searchParams.set('scope', 'org:create_api_key user:profile user:inference')
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', verifier)
  // Re-signing an expired account: pre-fill the address so the consent page and
  // Google's chooser land on the right login instead of asking who you are.
  if (loginHint) url.searchParams.set('login_hint', loginHint)

  const ses = session.fromPartition(LOGIN_PARTITION)
  ses.setUserAgent(BROWSER_UA)
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Sign in to Claude',
    autoHideMenuBar: true,
    webPreferences: { partition: LOGIN_PARTITION, nodeIntegration: false, contextIsolation: true }
  })
  win.webContents.setUserAgent(BROWSER_UA)

  const readSession = async (): Promise<PlainCookie[]> => {
    const all = await ses.cookies.get({ domain: 'claude.ai' }).catch(() => [])
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

  return new Promise<WebLoginResult | null>((resolve) => {
    let settled = false
    const done = (value: WebLoginResult | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!win.isDestroyed()) win.destroy()
    }

    const onNavigate = async (target: string): Promise<void> => {
      const hit = codeFrom(target)
      // Not the landing page, or it is but carries no code yet: keep waiting
      // rather than resolving null, or a redirect hop would cancel the sign-in.
      if (!hit) return
      done({
        code: hit.code,
        state: hit.state ?? verifier,
        verifier,
        redirectUri: CLAUDE_REDIRECT,
        cookies: await readSession()
      })
    }

    // Every navigation shape: a server redirect, a full load, and a client-side
    // route change, since the landing page may arrive by any of them.
    win.webContents.on('will-redirect', (_e, target) => void onNavigate(target))
    win.webContents.on('did-navigate', (_e, target) => void onNavigate(target))
    win.webContents.on('did-navigate-in-page', (_e, target) => void onNavigate(target))
    win.webContents.on('did-finish-load', () => void onNavigate(win.webContents.getURL()))
    win.on('closed', () => {
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    win.loadURL(url.toString())
  })
}
