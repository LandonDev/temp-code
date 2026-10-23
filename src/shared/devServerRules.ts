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

/** Why a listener is not a dev server, null when it may be one. */
export function notDevServer(port: number, name: string | null, command: string | null): string | null {
  if (NOT_DEV_PORTS.has(port)) return 'a database or debugger port'
  if (name && NOT_DEV_NAMES.test(name)) return `infrastructure (${name})`
  if (command && NOT_DEV_COMMAND.test(command)) return 'an MCP server, proxy or debugger'
  return null
}
