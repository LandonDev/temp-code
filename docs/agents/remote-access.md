# Remote access: the fixed port behind the tunnel

- A second listener (src/main/server/remote/listener.ts) binds
  `127.0.0.1:7677` by default; the Cloudflare tunnel on the box maps
  `tempcode.landonhale.com` to it, TLS ends at Cloudflare, and
  `CF-Connecting-IP` / `X-Forwarded-Proto` are believed only from a loopback
  socket. The renderer's random-port loopback socket is unchanged and stays
  implicitly admin.
- `TEMP_CODE_REMOTE_PORT=<n>` overrides the port for a dev instance (so it
  never fights the installed app for 7677); `0` turns the listener off. The
  settings `remote.enabled`, `remote.port`, `remote.publicOrigin` live in the
  settings table and this machine's section of Settings → Hosts edits them. A port in
  use logs one `[remote]` line and leaves remote off; `remote.status` carries
  the error. `TEMP_CODE_REMOTE_TRACE=1` logs one line per request.
- Identity: `<userData>/environment.json` holds `env_<22 chars>`, created
  once and never copied with the database. Every socket's first frame is
  `{ push: 'hello', environmentId, contract, caps, key? }`.
- Keys (remote/auth.ts): `tc_<id>.<secret>`, scrypt at rest, each with an
  audience (`client` for phones, browsers and desktops on `/ws` and `/api/*`;
  `mcp` for bots on `/mcp`, capped at read,operate) and a capability set from
  read | operate | approve | admin. Every RPC has a row in
  src/shared/capabilities.ts (`local` rows, every `app.*`, lsp, dap, idea,
  providers.update, fim and stall.report, never run for a remote caller);
  `session.create` with `permission: 'auto'` and `session.permission` need
  approve. The gate runs in `attach()` before any handler.
- The path fence (remote/fence.ts, R2 H1/H2): for every remote principal,
  each method that names a path or cwd (`fs.*`, `git.*`, `github.*`,
  `search.project`, `workspace.create`, `session.create`'s cwd, logo and
  command-list paths) must point, by real path, under a project cwd, a
  workspace path or the configured/box work root (never the bare home
  directory); the refusal is `forbidden: <method> is outside app-managed
  roots` and never logs the path. The loopback socket is unfenced. Nothing
  was demoted to `local`: the /ui bundle and the desktop's remote-host
  flows call the whole donor family, and the phone calls `fs.readPreview`,
  `search.project` and `github.*`. `fence.test.ts` asserts every
  path-taking contract method has a row. Inside the roots one directory
  is denied to every remote file method: the computer history
  (docs/computer-protocol.md §17.9), by a path named outright
  (`fenceRequest`'s `denied`), by one named through a project id or
  inside a `cwd`, and by a copy or a move whose source holds it
  (`fenceDenied`); `fsMedia` and project search leave it out for every
  caller.
- Pairing: an admin makes a code (`XXXXX-XXXXX`, 10 minutes, single use) in
  the pane or over `POST /api/pairings`; the link is `<origin>/pair#<code>`.
  Redemption claims the row in one conditional UPDATE before minting, so
  concurrent redeems answer one key (R2 M1). The link's origin is learned
  only from an admin's own authenticated request, never from the Host of an
  anonymous loopback request (L1); `/api/hello` without a key answers only
  the environment id and contract (L2); the `/pair` page's script and style
  run under a per-response nonce, the policy on the meta tag and the
  response header alike (`pairPageCsp`), no `'unsafe-inline'` anywhere (L3).
  `POST /api/pair` with `kind: 'key'` answers the raw key once; with
  `kind: 'session'` it sets the HttpOnly `tc_session` cookie that `/ui` and
  cookie upgrades of `/ws` use. The page (remote/pairPage.ts, on the app's
  tokens: `PAIR_TOKENS`, held equal to index.css by its test) shows the
  link's code and one Pair button, redeems nothing on load and strips the
  fragment before its first request; a bot pairing is refused a session
  before its code is spent (`SESSION_NEEDS_CLIENT`, 400), so the page
  redeems it as a key and shows that once with Copy. Any 401 reads one
  sentence: the wire never says whether a code existed. Bearer clients mint a 30 s ticket at
  `POST /api/ticket` and upgrade `/ws?ticket=…`; nothing else ever rides in
  a socket URL. Revoking a key closes its sockets and sessions at once.
- `/ui` serves the BUILT renderer (out/renderer, so `electron-vite build`
  first in a dev tree) behind the cookie; the bundle detects a missing
  `window.api` and runs in web mode (src/renderer/src/lib/nativeWeb.ts: no
  terminal, no Aliax pages, its own `web` workspace slot). A desktop-only
  control goes through `desktopOnly(handler)` (undefined at /ui, so its row
  is not drawn: the terminal's entry points, Choose logo…, the Updates
  row, the rail's Accounts and Stats, every Reveal row; a settings section
  or keybinding group marked `desktopOnly` in lib/settings.ts, Appshots and
  Terminal, is left out of the list); a desktop-only surface reached anyway
  (a stored Appshots route) shows `DESKTOP_ONLY_LINE`
  ("Available in the desktop app") in `Empty`; Open project browses the
  host's folders (`folderPickOn` in lib/fs.ts); a native ask is the app's
  confirm dialog (`askRequest` → `confirmAction`) and a native message a
  sonner toast, never the browser's confirm or alert. A signed-out tab: `/ui`
  answers a refused cookie `302 /pair?signed-out` (no cookie: `/pair`), and
  the cookie route asks `/api/hello` before its socket (`checkCookie` in
  lib/connection/registry.ts; a hello without `key` is `unauthorized:
  signed out`), on which tcserver/link.ts replaces the page with
  `/pair?signed-out`. `/asset/<host>/…`
  mirrors `tempcode-asset://` for logos, media and agent pages.
- Webhook targets (remote/addressGuard.ts, R2 M3): a key's webhook URL and
  a hub subscription URL must be https to a public host; loopback, RFC 1918,
  CGNAT, link-local (169.254.169.254), v6 unique-local/link-local, `.internal`,
  `.local` and bare names are refused when made, the host is resolved then,
  and each delivery pins the socket's lookup to re-checked addresses (the hub
  resolves over DNS-over-HTTPS before every POST). `TEMP_CODE_WEBHOOK_ALLOW_LOOPBACK=1`
  admits a 127.0.0.1 receiver for a proof script; nothing else private, ever.
- Proof: `bun run script:e2e-remote` (the bearer flow against a temp
  server), `bun run script:e2e-remote-fence` (in the release gate: the fence
  for a read and an operate key on every path-taking method, the concurrent
  pairing redeem, refused webhook targets, the learned origin, the anonymous
  hello and the pair page CSP) and `bun scripts/e2e-remote-ui.ts` (an
  isolated preview instance plus a real Chrome profile over CDP through
  `/pair`, `/ui`, a thread, a reply, the cookie and the CSP rewrite).
