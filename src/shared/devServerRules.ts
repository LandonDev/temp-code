/**
 * What is never a dev server (docs/box.md "Dev servers on the box"): the
 * host's sweep skips these listeners before crediting a thread
 * (src/main/server/portSweep.ts), and the Dev servers pane drops a ledger row
 * that still matches one (a row recorded before a rule existed).
 */

/** Databases, queues, caches and debugger ports. */
export const NOT_DEV_PORTS = new Set([
  1433, 2181, 3306, 4222, 5432, 5433, 5672, 5984, 6379, 6380, 7687, 8086, 8123, 8529, 9042, 9092, 9200, 9222, 9229, 9300, 11211, 15672, 26257,
  27017, 27018, 33060
])

/** Process names (as ss and lsof print them, 15 characters on Linux) of infrastructure, proxies and the app itself. */
export const NOT_DEV_NAMES =
  /^(?:postgres|postmaster|mysqld|mariadbd|redis-server|valkey-server|mongod|mongos|clickhouse(?:-server)?|memcached|beam\.smp|docker-proxy|dockerd|containerd|sshd|cloudflared|ngrok|tailscaled|systemd.*|dnsmasq|nginx|caddy|haproxy|envoy|traefik|squid|mitmproxy|mitmdump|privoxy|tinyproxy|socat|electron|chrome|chromium|headless_shell|claude|codex|.*\bhelper\b.*)$/i

/** A command line that names an MCP server, a proxy or a browser's debugger (a folder named `x-mcp/` in a `cd` does not count). */
export const NOT_DEV_COMMAND =
  /modelcontextprotocol|\bmcp[-_](?:server|proxy|remote)\b|[-_]mcp\b(?![/.-])|^(?:\S*\/)?(?:nginx|caddy|haproxy|envoy|traefik|mitmproxy|mitmdump|socat)\b|--remote-debugging-port/i

/** A test run, a typecheck, the release gate, or one of this repository's
 *  own proofs (`scripts/e2e-*`, their esbuild output under `scripts/.out/`,
 *  a run under the electron-stub preload): their workers, fake providers
 *  and in-process servers listen on throwaway ports while they run. */
export const NOT_DEV_RUNNER =
  /\bscripts\/gate\.ts\b|\bscripts\/e2e-[\w-]+\.(?:ts|mjs|js)\b|\bscripts\/\.out\/[\w-]+\.mjs\b|--preload\s+scripts\/lib\/electron-stub\.ts\b|\/node_modules\/(?:\.bin\/)?(?:vitest|jest|mocha|@playwright\/test)\b|(?:^|[\s;&|(])(?:bunx\s+|npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:vitest|jest|mocha|tsc)(?=\s|$)|\bplaywright\s+test\b|\bbun\s+test\b|\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|gate)(?=[\s:]|$)/

/** A listener under a test run, a typecheck or the gate, by ANY process
 *  above it: a vitest worker's own command names tinypool, not the gate
 *  that runs it, so the runner is found on the way up (the sweep's chain,
 *  the shell-call detector's ancestry). */
export function underRunner(commands: readonly (string | null | undefined)[]): boolean {
  return commands.some((c) => !!c && NOT_DEV_RUNNER.test(c))
}

/** Why a listener is not a dev server, null when it may be one. */
export function notDevServer(port: number, name: string | null, command: string | null): string | null {
  if (NOT_DEV_PORTS.has(port)) return 'a database or debugger port'
  if (name && NOT_DEV_NAMES.test(name)) return `infrastructure (${name})`
  if (command && NOT_DEV_COMMAND.test(command)) return 'an MCP server, proxy or debugger'
  if (command && NOT_DEV_RUNNER.test(command)) return 'a test run or the gate'
  return null
}
