/**
 * TEMP_CODE_PEER_DELAY_MS=<ms>, isolated instances only: every request a
 * REMOTE principal makes on this host waits that long before it is handled,
 * so a proof can play a slow or sleeping box against a desktop that boots
 * from its launch mirror (scripts/e2e-launch-mirror.ts). Local sockets
 * never wait; the value is read once at boot.
 */
export function peerDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TEMP_CODE_PEER_DELAY_MS
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Resolves after the configured delay for a remote principal; at once otherwise. */
export function peerDelay(principalKind: 'local' | 'remote', delayMs: number): Promise<void> {
  if (delayMs <= 0 || principalKind !== 'remote') return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}
