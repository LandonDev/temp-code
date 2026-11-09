/** Attribute a refusal-proxy connection while its client socket is still open. */
import { execFileSync } from 'node:child_process'

export function peerPidFromSs(text: string, clientPort: number, proxyPort: number): number | null {
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (
      !columns.some(
        (c, i) => c.endsWith(`:${clientPort}`) && columns[i + 1]?.endsWith(`:${proxyPort}`)
      )
    )
      continue
    const pid = /\bpid=(\d+)/.exec(line)?.[1]
    if (pid) return Number(pid)
  }
  return null
}

export function peerPidFromLsof(
  text: string,
  clientPort: number,
  proxyPort: number
): number | null {
  let pid: number | null = null
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    if (line.startsWith('n') && new RegExp(`:${clientPort}->[^>]+:${proxyPort}$`).test(line))
      return pid
  }
  return null
}

export function proxyPeerPid(clientPort: number, proxyPort: number): number | null {
  try {
    if (process.platform === 'linux')
      return peerPidFromSs(
        execFileSync(
          'ss',
          ['-tnp', 'sport', '=', `:${clientPort}`, 'dport', '=', `:${proxyPort}`],
          { encoding: 'utf8' }
        ),
        clientPort,
        proxyPort
      )
    if (process.platform === 'darwin')
      return peerPidFromLsof(
        execFileSync(
          '/usr/sbin/lsof',
          ['-nP', `-iTCP:${clientPort}`, '-sTCP:ESTABLISHED', '-Fpn'],
          { encoding: 'utf8' }
        ),
        clientPort,
        proxyPort
      )
  } catch {
    /* the process may already have exited */
  }
  return null
}
