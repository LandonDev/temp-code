import { execFileSync } from 'node:child_process'

/** Inherited by each proof's service, including a service orphaned by a killed runner. */
export const COMPUTER_PROOF_ENV = { TEMP_CODE_COMPUTER_PROOF: '1' }

interface ProcessRow { pid: number; ppid: number; command: string }

function processRows(ps: string): ProcessRow[] {
  return ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }] : []
  })
}

const proofRunner = (command: string): boolean =>
  /(?:^|[\s/])(?:e2e-(?:tc-computer|computer(?:-[\w-]+)?)|compare-computer-words)\.(?:ts|mjs)(?:\s|$)/.test(command)

/**
 * `ps eww -Ao pid=,ppid=,command=`: the environment proves ownership after a runner dies.
 * Never match a shell quoting a command, an unmarked development service, or the installed app.
 * Older gate services predate our marker but carry TC_PROOF_UNGATED=1 or the bridge's scratch HOME.
 * Skip descendants of another live proof; the startup sweep runs only after our turn arrives.
 */
export function staleComputerProofPids(ps: string, self: number): number[] {
  const rows = processRows(ps)
  const byId = new Map(rows.map((row) => [row.pid, row]))
  return rows.filter((row) => {
    if (row.pid === self) return false
    const probe = /^\/(?:private\/)?(?:tmp|var\/folders)\/[^\n]*\/TC Probe( Steal)?\.app\/Contents\/MacOS\/TC Probe\1(?:\s|$)/.test(row.command)
    const service = /^\/(?:Users|srv|private|tmp|var)\/[^\n]*\/resources\/native\/tc-computer (?:serve|hold-lock)(?:\s|$)/.test(row.command)
    if (!probe && !service) return false
    if (/^\/.*\/TempCode\.app\/Contents\//.test(row.command)) return false
    let owned = /(?:^|\s)(?:TEMP_CODE_COMPUTER_PROOF=1|TC_PROOF_UNGATED=1)(?:\s|$)/.test(row.command) ||
      /(?:^|\s)(?:HOME|TEMP_CODE_USER_DATA)=\/(?:private\/)?(?:tmp|var\/folders\/\S+)\/tc-computer-bridge-mac-[^\s]+/.test(row.command)
    const seen = new Set([row.pid])
    for (let parent = byId.get(row.ppid); parent && !seen.has(parent.pid); parent = byId.get(parent.ppid)) {
      seen.add(parent.pid)
      if (proofRunner(parent.command)) {
        if (parent.pid !== self) return false
        owned = true
      }
    }
    return probe || owned
  }).map((row) => row.pid)
}

/** Every exact binary match, including copies started through /private/tmp before launch returned. */
export function probeAppPids(ps: string, spellings: readonly string[]): number[] {
  return ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    return m && spellings.some((binary) => m[2] === binary || m[2].startsWith(`${binary} `)) ? [Number(m[1])] : []
  })
}

/** End all matches, TERM then KILL after a bounded grace. No command or environment enters a log. */
export function stopProofPids(pids: readonly number[]): number[] {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const ended: number[] = []
  for (const pid of new Set(pids)) {
    if (pid <= 1 || pid === process.pid) continue
    try { process.kill(pid, 'SIGTERM'); ended.push(pid) } catch { /* gone */ }
  }
  for (const until = Date.now() + 1_000; ended.some(alive) && Date.now() < until; )
    execFileSync('sleep', ['0.1'])
  for (const pid of ended) if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  return ended
}

export function sweepComputerProofProcesses(log: (line: string) => void): void {
  const ps = execFileSync('ps', ['eww', '-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  for (const pid of stopProofPids(staleComputerProofPids(ps, process.pid))) log(`ended stale computer proof process ${pid}`)
}
