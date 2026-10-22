/**
 * Stopping an instance a proof launched, by the pids it launched, on macOS
 * and Linux alike. `electron-vite preview` is a wrapper whose child is
 * Electron's main process; SIGTERM to the wrapper alone leaves Electron
 * running, re-parented to launchd or init, with its helpers, its gateway
 * process and every CLI it spawned. So the tree is walked by parent pid
 * BEFORE any signal (a dying parent hands its children on), the roots get
 * SIGTERM (main's handler records its threads and kills what it tracks),
 * and whatever of the tree outlives the grace gets SIGKILL. Never a pattern.
 */
import { sleep, sh } from './packagedApp'

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The live roots and every live descendant of them. */
export async function processTree(roots: number[]): Promise<number[]> {
  const out = await sh(['ps', '-A', '-o', 'pid=', '-o', 'ppid='], { quiet: true })
  const children = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  const seen = new Set<number>()
  const queue = roots.filter((p) => p > 0 && p !== process.pid && alive(p))
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}

/** SIGTERM the roots, wait for the whole tree, SIGKILL what is left. Returns the pids that needed SIGKILL. */
export async function stopTree(roots: number[], graceMs = 10_000): Promise<number[]> {
  const tree = await processTree(roots)
  for (const pid of roots) {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGTERM')
  }
  const end = Date.now() + graceMs
  while (Date.now() < end && tree.some(alive)) await sleep(200)
  const left = tree.filter(alive)
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  return left
}
