import { SESSION_NEEDS_CLIENT } from './auth'

/**
 * `/pair`, the page a pairing link opens (docs/box.md "Pairing"). One centred
 * column on the app's tokens: the code (from the link's fragment, or typed),
 * one Pair button, one line that says what happened. A client link signs the
 * browser in and goes to `/ui/`; a bot (MCP) link is refused a session before
 * its code is spent, so the page redeems the same code as a key and shows it
 * once. Nothing redeems on load: a link preview that runs scripts never burns
 * the code. The one script runs under a per-response nonce (R2 L3).
 */

/** The values the page needs from the top of src/renderer/src/index.css;
 *  pairPage.test.ts holds them equal to the app's. */
export const PAIR_TOKENS = {
  dark: {
    background: 'oklch(0.195 0.003 270)',
    card: 'oklch(0.225 0.004 270)',
    secondary: 'oklch(0.29 0.004 270)',
    input: 'rgb(255 255 255 / 0.12)',
    border: 'rgb(255 255 255 / 0.09)',
    foreground: 'oklch(0.93 0.003 270)',
    'muted-foreground': 'oklch(0.68 0.006 270)',
    primary: 'oklch(0.96 0 0)',
    'primary-foreground': 'oklch(0.2 0 0)',
    accent: 'hsl(211 92% 62%)',
    destructive: '#f87171'
  },
  light: {
    background: 'oklch(1 0 0)',
    card: 'oklch(0.985 0.002 80)',
    secondary: 'oklch(0.94 0.003 80)',
    input: 'rgb(0 0 0 / 0.12)',
    border: 'rgb(0 0 0 / 0.08)',
    foreground: 'oklch(0.2 0.004 270)',
    'muted-foreground': 'oklch(0.5 0.008 270)',
    primary: 'oklch(0.2 0 0)',
    'primary-foreground': 'oklch(0.99 0 0)',
    accent: 'hsl(211 92% 48%)',
    destructive: '#dc2626'
  },
  shared: {
    'dur-fast': '120ms',
    'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    'font-sans':
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
    'font-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  }
} as const

/** The page's one line for a refused code, whatever the reason (the wire keeps one 401, R2). */
export const PAIR_INVALID_LINE = 'This code is invalid or has expired. Make a new one in Settings → Hosts on your computer.'

const vars = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ')

/** JSON safe inside a script element. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

/** The page's script, alone so the test can run it in a document of its own. */
export function pairPageScript(): string {
  return `(function () {
  var NEEDS_CLIENT = ${scriptJson(SESSION_NEEDS_CLIENT)};
  var INVALID = ${scriptJson(PAIR_INVALID_LINE)};
  var form = document.getElementById('f'), title = document.getElementById('title'), go = document.getElementById('go'), line = document.getElementById('line');
  var code = document.getElementById('code');
  var linked = '';
  try { linked = decodeURIComponent(location.hash.slice(1)).trim(); } catch (e) { linked = location.hash.slice(1).trim(); }
  var deviceName = (function (ua) {
    var b = /Edg\\//.test(ua) ? 'Edge' : /OPR\\//.test(ua) ? 'Opera' : /Chrome\\//.test(ua) ? 'Chrome' : /Firefox\\//.test(ua) ? 'Firefox' : /Safari\\//.test(ua) ? 'Safari' : 'Browser';
    var os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? b + ' on ' + os : b;
  })(navigator.userAgent);

  function say(text, failed) {
    line.textContent = text;
    line.className = failed ? 'failed' : '';
  }
  function field() {
    var input = document.createElement('input');
    input.id = 'code';
    input.placeholder = 'XXXXX-XXXXX';
    input.setAttribute('aria-label', 'Pairing code');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'characters');
    return input;
  }
  if (linked) {
    code.textContent = linked;
  } else {
    var typed = field();
    code.replaceWith(typed);
    code = typed;
    code.focus();
  }
  if (/(^|[?&])signed-out(=|&|$)/.test(location.search.slice(1))) say('Signed out.');

  function post(body) {
    return fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j || {}, retry: r.headers.get('Retry-After') }; });
    });
  }
  function refused(r) {
    go.disabled = false;
    if (r.status === 401) {
      say(INVALID, true);
      if (code.tagName !== 'INPUT') {
        var input = field();
        code.replaceWith(input);
        code = input;
      }
      code.value = '';
      code.focus();
      return;
    }
    if (r.status === 429) {
      var minutes = Math.max(1, Math.ceil((Number(r.retry) || 60) / 60));
      return say('Too many tries. Try again in ' + minutes + ' min.', true);
    }
    say((r.body && r.body.error) || 'Pairing failed (' + r.status + ').', true);
  }
  function unreachable() {
    go.disabled = false;
    say("Couldn't reach this host.", true);
  }
  function showKey(name, key) {
    title.textContent = name || 'Key';
    var block = document.createElement('div');
    block.id = 'key';
    block.textContent = key;
    var copy = document.createElement('button');
    copy.id = 'copy';
    copy.type = 'button';
    copy.textContent = 'Copy';
    var timer = 0;
    copy.addEventListener('click', function () {
      var done = function () {
        copy.textContent = 'Copied';
        clearTimeout(timer);
        timer = setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      };
      if (window.isSecureContext && navigator.clipboard) return void navigator.clipboard.writeText(key).then(done, function () {});
      var range = document.createRange();
      range.selectNodeContents(block);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (document.execCommand('copy')) done();
    });
    form.replaceWith(block);
    block.after(copy);
    say('Shown once.');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = code.tagName === 'INPUT' ? code.value.trim() : code.textContent;
    if (!value) return void code.focus();
    // A reload never retries a spent code or shows it again.
    history.replaceState(null, '', location.pathname + location.search);
    go.disabled = true;
    say('Pairing…');
    post({ code: value, kind: 'session', name: deviceName })
      .then(function (r) {
        if (r.ok) {
          say('Paired.');
          location.replace('/ui/');
          return;
        }
        if (r.status === 400 && r.body && r.body.error === NEEDS_CLIENT)
          return post({ code: value, kind: 'key' }).then(function (k) {
            if (k.ok && k.body && k.body.key) return showKey(k.body.name, k.body.key);
            refused(k);
          });
        refused(r);
      })
      .catch(unreachable);
  });
})();`
}

export function pairPageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'">
<title>Pair this browser</title>
<style>
  :root { color-scheme: light dark; ${vars(PAIR_TOKENS.dark)} ${vars(PAIR_TOKENS.shared)} }
  @media (prefers-color-scheme: light) { :root { ${vars(PAIR_TOKENS.light)} } }
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in oklab, var(--accent) 35%, transparent); }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--background); color: var(--foreground); font: 13px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; caret-color: var(--foreground); }
  main { width: min(320px, calc(100vw - 48px)); display: flex; flex-direction: column; }
  h1 { margin: 0 0 16px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
  #code { height: 32px; display: flex; align-items: center; font: 15px var(--font-mono); font-variant-numeric: tabular-nums; }
  input#code { width: 100%; padding: 0 10px; border: 1px solid var(--input); border-radius: 8px; background: transparent; color: inherit; font-size: 13px; text-transform: uppercase; outline: none; transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
  input#code::placeholder { color: var(--muted-foreground); }
  input#code:focus-visible { border-color: var(--accent); box-shadow: inset 0 0 0 0.5px var(--accent); }
  button { height: 32px; width: 100%; border: 0; border-radius: 8px; font: 500 13px var(--font-sans); cursor: default; transition: background-color var(--dur-fast) var(--ease-out), scale var(--dur-fast) var(--ease-out); }
  button:active:not(:disabled) { scale: 0.985; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; }
  #go { background: var(--primary); color: var(--primary-foreground); }
  #go:hover:not(:disabled) { background: color-mix(in oklab, var(--primary) 90%, transparent); }
  #copy { margin-top: 12px; background: var(--secondary); color: var(--foreground); }
  #copy:hover { background: color-mix(in oklab, var(--secondary) 80%, transparent); }
  #key { padding: 12px; border-radius: 8px; background: var(--card); font: 13px/1.5 var(--font-mono); user-select: all; -webkit-user-select: all; overflow-wrap: anywhere; }
  #line { margin: 8px 0 0; min-height: 36px; font-size: 12px; line-height: 18px; color: var(--muted-foreground); }
  #line.failed { color: var(--destructive); }
  @media (prefers-reduced-motion: reduce) { button, input#code { transition: none; } button:active:not(:disabled) { scale: 1; } }
</style></head>
<body>
<main>
  <h1 id="title">Pair this browser</h1>
  <form id="f" autocomplete="off">
    <div id="code"></div>
    <button id="go" type="submit">Pair</button>
  </form>
  <p id="line" role="status"></p>
</main>
<script nonce="${nonce}">
${pairPageScript()}
</script>
</body></html>
`
}
