/**
 * One computer proof on the Mac at a time (the person's rule of 2026-11-09).
 * A proof waits only for an older one, judged by each proof's wrapper (the
 * `bun run` that started it, not its node runner), so two proofs started in
 * any order never wait on each other. Used by the task benchmark, the words
 * comparison, the tier scheduling proof and the bridge proof, and by every
 * computer row of the gate before it starts.
 */
import { execFileSync } from 'node:child_process'

/** The computer proofs, by a piece of their command line. */
export const COMPUTER_PROOFS: readonly string[] = [
  'scripts/.out/e2e-computer.mjs',
  'e2e-tc-computer',
  'tc-computer-proof/',
  'ax-reader-proof',
  'tc-ax-proof',
  'input-proof',
  'capture-proof',
  'e2e-computer-schedule',
  'e2e-computer-preview',
  'e2e-computer-ui',
  'compare-computer-words',
  'e2e-computer-bench',
  'e2e-computer-bridge'
]

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = rest.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(days) * 86_400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/**
 * The first other proof in `ps -Ao pid=,ppid=,etime=,command=` output that
 * started before this one, or null. Each proof is its topmost process that
 * names one (its wrapper), compared by age, then by pid; this process's own
 * proof, and any `pgrep` or `ps` naming a pattern, never count.
 */
export function otherProofIn(ps: string, self: number, patterns: readonly string[] = COMPUTER_PROOFS): string | null {
  const rows = new Map<number, { ppid: number; age: number; command: string }>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), age: etimeSeconds(m[3]), command: m[4] })
  }
  const proofOf = (pid: number): string | null => {
    const command = rows.get(pid)?.command
    if (!command || /\bpgrep\b|\bps -Ao\b/.test(command)) return null
    // Scratch children can outlive a failed runner. Its wrapper owns the turn;
    // an orphaned app/helper must reach the next proof's startup sweep.
    if (/^\/.*\/tc-computer-proof\/(?:TC Probe\.app\/Contents\/MacOS\/TC Probe|computer-proof-probe)(?:\s|$)/.test(command)) return null
    return patterns.find((p) => command.includes(p)) ?? null
  }
  /** The wrapper: the topmost process up the chain that names a proof. */
  const wrapper = (pid: number): number => {
    let top = pid
    for (let p = rows.get(pid)?.ppid; p && proofOf(p) && p !== top; p = rows.get(p)?.ppid) top = p
    return top
  }
  const mine = wrapper(self)
  const myAge = rows.get(mine)?.age ?? 0
  for (const pid of rows.keys()) {
    const hit = proofOf(pid)
    if (!hit) continue
    const theirs = wrapper(pid)
    if (theirs === mine) continue
    const age = rows.get(theirs)!.age
    if (age > myAge || (age === myAge && theirs < mine)) return hit
  }
  return null
}

export function otherProof(patterns: readonly string[] = COMPUTER_PROOFS): string | null {
  try {
    return otherProofIn(execFileSync('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' }), process.pid, patterns)
  } catch {
    return null
  }
}
