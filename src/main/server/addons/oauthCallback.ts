import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SIGNIN_TIMEOUT } from '@shared/addonGrantWords'
import { PAIR_TOKENS } from '../remote/pairPage'

/**
 * The loopback listener an add-on sign-in's redirect lands on
 * (plan-8YMm3ynnFZYs.md §6): `http://127.0.0.1:<port>/callback`, on
 * 127.0.0.1 only. The app's own local server answers plain HTTP with 426, so
 * each sign-in binds its own, on the add-on's fixed port (a server that
 * matches redirect URIs exactly, as Supabase does, needs the same one every
 * time), and keeps it bound to the end so nothing else takes the port the
 * client is registered for mid-flow.
 *
 * Only a callback carrying this sign-in's `state` is taken, success or error
 * alike; any other answers the failure page and is ignored, and the listener
 * keeps waiting for the real one. Every other path or method is a 404. It
 * closes after the first matching callback, on abort, and at the timeout.
 */

export const ADDON_SIGNIN_TIMEOUT_MS = 5 * 60_000

export type CallbackResult = { code: string } | { error: string; description?: string }

export interface CallbackServer {
  port: number
  /** The first GET /callback whose state matches: its code, or its error and description. Rejects on abort and at the timeout (SIGNIN_TIMEOUT). */
  next(signal: AbortSignal): Promise<CallbackResult>
  close(): Promise<void>
}

const vars = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([k, v]) => `--${k}: ${v};`)
    .join(' ')

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** The page the browser shows: one line on the pair page's tokens, no script. */
export function callbackPage(line: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TempCode</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; ${vars(PAIR_TOKENS.dark)} ${vars(PAIR_TOKENS.shared)} }
  @media (prefers-color-scheme: light) { :root { ${vars(PAIR_TOKENS.light)} } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--background); color: var(--foreground); font: 13px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
  p { margin: 0; width: min(320px, calc(100vw - 48px)); }
</style></head>
<body><p>${escapeHtml(line)}</p></body></html>
`
}

export const callbackCsp = (nonce: string): string => `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

export const SIGNED_IN_LINE = (name: string): string => `Signed in to ${name}. You can close this tab.`
export const NOT_FINISHED_LINE = 'The sign-in did not finish.'

export function oauthCallback(port: number, state: string, opts: { name?: string; timeoutMs?: number } = {}): Promise<CallbackServer> {
  let result: CallbackResult | null = null
  let settle: ((r: CallbackResult) => void) | null = null
  let server: Server | null = null
  let closed = false

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (closed || !server) return resolve()
      closed = true
      server.closeAllConnections?.()
      server.close(() => resolve())
    })

  const page = (status: number, line: string, res: import('node:http').ServerResponse): void => {
    const nonce = randomBytes(16).toString('base64')
    res
      .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': callbackCsp(nonce), 'referrer-policy': 'no-referrer' })
      .end(callbackPage(line, nonce))
  }

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') return void res.writeHead(404).end()
    const q = url.searchParams
    if (result || q.get('state') !== state) return page(400, NOT_FINISHED_LINE, res)
    const code = q.get('code')
    const error = q.get('error')
    if (code && !error) {
      result = { code }
      page(200, SIGNED_IN_LINE(opts.name ?? 'the add-on'), res)
    } else {
      const description = q.get('error_description')
      result = { error: error ?? 'invalid_request', ...(description ? { description } : {}) }
      page(400, NOT_FINISHED_LINE, res)
    }
    res.on('finish', () => void close())
    settle?.(result)
  })

  return new Promise((resolve, reject) => {
    const s = server!
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => {
      s.off('error', reject)
      const bound = (s.address() as AddressInfo).port
      if (bound < 1024) {
        void close()
        return reject(new Error(`refused: port ${bound} is below 1024`))
      }
      resolve({
        port: bound,
        close,
        next(signal: AbortSignal): Promise<CallbackResult> {
          if (result) return Promise.resolve(result)
          return new Promise<CallbackResult>((done, fail) => {
            const timer = setTimeout(() => {
              void close()
              fail(new Error(SIGNIN_TIMEOUT))
            }, opts.timeoutMs ?? ADDON_SIGNIN_TIMEOUT_MS)
            timer.unref?.()
            const onAbort = (): void => {
              clearTimeout(timer)
              void close()
              fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            }
            if (signal.aborted) return onAbort()
            signal.addEventListener('abort', onAbort, { once: true })
            settle = (r) => {
              clearTimeout(timer)
              signal.removeEventListener('abort', onAbort)
              done(r)
            }
          })
        }
      })
    })
  })
}
