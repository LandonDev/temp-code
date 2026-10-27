import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { ASSET_SCHEME } from '@shared/assets'
import type { RequestContext, UiHandler } from './listener'
import { notFound } from './listener'
import type { Verified } from './auth'

/**
 * The browser face of the fixed port (plan 5jtfkIC45Cbr): `/pair` signs a
 * browser in with a pairing code, `/ui/` serves the BUILT renderer
 * (out/renderer, the same bundle the desktop window loads) behind the
 * session cookie. The bundle runs in web mode there (lib/nativeWeb.ts),
 * talks to `/ws` on its own origin, and the CSP meta is rewritten per host
 * so Safari, which does not stretch 'self' to wss:, connects too.
 */

/** Module scripts and workers need a JavaScript type; a file:// fetch would
 *  sniff one, but spelling it keeps the renderer's loads deterministic.
 *  appScheme.ts (tempcode-app://) uses the same table. */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

export function mimeFor(path: string): string | undefined {
  return MIME[extname(path).toLowerCase()]
}

/** A path under `root`, or null when `pathname` escapes it (same rule as assets.ts's fenced). */
export function fencedUnder(root: string, pathname: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!relative || relative.includes('\0')) return null
  const base = resolve(root)
  const target = resolve(join(base, relative))
  return target === base || target.startsWith(base + sep) ? target : null
}

/**
 * The served index.html's CSP must let the page reach its own host over
 * WebSocket and https: `'self'` covers https everywhere, but WebKit does
 * not extend it to wss:, so the host is spelled into connect-src.
 */
export function rewriteCsp(html: string, host: string, proto: 'http' | 'https'): string {
  const ws = proto === 'https' ? 'wss' : 'ws'
  return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i, (_m, open: string, policy: string, close: string) => {
    const extra = `${ws}://${host} ${proto}://${host}`
    let rewritten = policy.includes('connect-src')
      ? policy.replace(/connect-src([^;]*)/, (_c, rest: string) => `connect-src${rest} ${extra}`)
      : `${policy}; connect-src 'self' ${extra}`
    // Agent pages come from /asset/page on this origin here, not from the asset scheme.
    if (/frame-src(?![^;]*'self')/.test(rewritten)) rewritten = rewritten.replace(/frame-src/, "frame-src 'self'")
    return `${open}${rewritten}${close}`
  })
}

export interface UiOptions {
  /** The built renderer: out/renderer under the app path. */
  rendererDir: string
  /** The tempcode-asset:// handler (src/main/assets.ts), when the host has one; `/asset/*` mirrors it. */
  assets?: (request: Request) => Promise<Response>
}

/** `/asset/<host>/<path>?q` → the `tempcode-asset://<host>/<path>?q` request the protocol handler takes. */
export function assetRequestFor(url: string, req: { method?: string; headers: Record<string, string | string[] | undefined> }): Request | null {
  const m = /^\/asset\/([a-z]+)(\/[^?]*)?(\?.*)?$/.exec(url)
  if (!m) return null
  const range = req.headers.range
  return new Request(`${ASSET_SCHEME}://${m[1]}${m[2] ?? '/'}${m[3] ?? ''}`, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: typeof range === 'string' ? { range } : {}
  })
}

/** The sign-in page: the code comes in the fragment (never sent to the server by the link itself).
 *  Its one script runs under a per-response nonce, so the policy allows no inline script at all (R2 L3). */
export function pairPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'">
<title>Pair this browser</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: hsl(240 0% 9%); color: #e8e8e8; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  form { width: min(360px, calc(100vw - 48px)); display: grid; gap: 12px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0; color: #9a9a9a; font-size: 13px; }
  label { display: grid; gap: 6px; font-size: 12px; color: #9a9a9a; }
  input { font: inherit; padding: 9px 11px; border-radius: 8px; border: 1px solid #333; background: #161616; color: inherit; outline: none; }
  input:focus { border-color: #555; }
  #code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
  button { font: inherit; font-weight: 500; padding: 10px; border-radius: 8px; border: 0; background: #e8e8e8; color: #111; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  #error { color: #ff6b6b; font-size: 13px; min-height: 1.2em; }
</style></head>
<body>
<form id="f" autocomplete="off">
  <h1>Pair this browser</h1>
  <p>Enter the code from the app's Settings → Hosts.</p>
  <label>Pairing code<input id="code" name="code" required placeholder="XXXXX-XXXXX" spellcheck="false" autocapitalize="characters"></label>
  <label>Name this browser<input id="name" name="name" placeholder="Chrome on iPad"></label>
  <div id="error" role="alert"></div>
  <button id="go" type="submit">Sign in</button>
</form>
<script nonce="${nonce}">
(function () {
  var code = document.getElementById('code'), name = document.getElementById('name'), err = document.getElementById('error'), go = document.getElementById('go');
  var fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash) code.value = fromHash;
  if (!name.value) name.value = (function (ua) {
    var b = /Edg\\//.test(ua) ? 'Edge' : /OPR\\//.test(ua) ? 'Opera' : /Chrome\\//.test(ua) ? 'Chrome' : /Firefox\\//.test(ua) ? 'Firefox' : /Safari\\//.test(ua) ? 'Safari' : 'Browser';
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? b + ' on ' + os : b;
  })(navigator.userAgent);
  (fromHash ? name : code).focus();
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    go.disabled = true;
    fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, kind: 'session', name: name.value }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (r) {
        if (r.ok) { history.replaceState(null, '', '/pair'); location.replace('/ui/'); return; }
        err.textContent = (r.body && r.body.error) || ('Sign-in failed (' + r.status + ')');
        go.disabled = false;
      })
      .catch(function () { err.textContent = 'Could not reach the server.'; go.disabled = false; });
  });
})();
</script>
</body></html>
`
}

function send(res: RequestContext['res'], status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra })
  res.end(body)
}

/** Routes `/pair`, `/ui` and `/ui/*`; true when answered. */
export function createUiHandler(options: UiOptions): UiHandler {
  const root = resolve(options.rendererDir)
  const indexPath = join(root, 'index.html')
  return async (ctx) => {
    const { req, res, path } = ctx
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (path === '/pair') {
      send(res, 200, pairPageHtml(randomBytes(16).toString('base64')), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' })
      return true
    }
    const isAsset = path.startsWith('/asset/')
    if (path !== '/ui' && !path.startsWith('/ui/') && !isAsset) return false

    let verified: Verified | null = null
    try {
      verified = await ctx.principal()
    } catch {
      verified = null
    }
    const isDocument = path === '/ui' || path === '/ui/' || path === '/ui/index.html'
    // The asset mirror also answers an app key sent as a bearer: the phone
    // loads logos and media with its key, never with a cookie. Bot keys stay out.
    const bearerAsset = isAsset && verified !== null && !verified.session && verified.principal.audience === 'client'
    if (!verified?.session && !bearerAsset) {
      // The document sends the browser to sign in; an asset without a cookie
      // is a plain 401, so a stale tab fails fast instead of redirecting scripts.
      if (isDocument) {
        res.writeHead(302, { Location: '/pair', 'Cache-Control': 'no-store' })
        res.end()
      } else send(res, 401, 'sign in at /pair', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' })
      return true
    }
    if (isAsset) {
      const request = options.assets ? assetRequestFor(req.url ?? '', req) : null
      if (!request) return void notFound(res), true
      const out = await options.assets!(request)
      const headers: Record<string, string> = {}
      out.headers.forEach((value, name) => {
        headers[name] = value
      })
      res.writeHead(out.status, headers)
      if (!out.body || req.method === 'HEAD') return void res.end(), true
      Readable.fromWeb(out.body as import('node:stream/web').ReadableStream).pipe(res)
      return true
    }
    if (!existsSync(indexPath)) {
      send(res, 503, 'build the renderer first (electron-vite build)', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' })
      return true
    }
    if (path === '/ui') {
      // Relative asset URLs in index.html need the trailing slash.
      res.writeHead(302, { Location: '/ui/', 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    if (isDocument) {
      const html = rewriteCsp(readFileSync(indexPath, 'utf8'), ctx.host, ctx.proto)
      send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' })
      return true
    }
    const file = fencedUnder(root, path.slice('/ui/'.length))
    if (!file) return void notFound(res), true
    let st
    try {
      st = statSync(file)
    } catch {
      return void notFound(res), true
    }
    if (!st.isFile()) return void notFound(res), true
    const headers: Record<string, string> = {
      'Content-Type': mimeFor(file) ?? 'application/octet-stream',
      'Content-Length': String(st.size),
      // Vite hashes everything under assets/; the rest (boot.js, the logo) is revalidated.
      'Cache-Control': path.startsWith('/ui/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return void res.end(), true
    createReadStream(file).pipe(res)
    return true
  }
}
