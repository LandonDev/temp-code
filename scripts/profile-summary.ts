import { readFileSync } from 'node:fs'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}

export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

export function profileSummary(profile: CpuProfile): string {
  const self = new Map<number, number>()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const total = new Map<number, number>()
  // Postorder without recursion: a long stack in a capture must fit here too.
  for (const node of profile.nodes) {
    const stack: [number, boolean][] = [[node.id, false]]
    while (stack.length) {
      const [id, visited] = stack.pop()!
      if (total.has(id)) continue
      const children = nodes.get(id)?.children ?? []
      if (!visited) {
        stack.push([id, true])
        for (const child of children) stack.push([child, false])
      } else {
        total.set(id, (self.get(id) ?? 0) + children.reduce((sum, child) => sum + (total.get(child) ?? 0), 0))
      }
    }
  }
  const frames = new Map<string, { name: string; location: string; self: number; total: number }>()
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame
    const key = JSON.stringify([functionName, url, lineNumber])
    const frame = frames.get(key) ?? {
      name: functionName || '(anonymous)',
      location: `${url || '(native)'}:${lineNumber + 1}`,
      self: 0,
      total: 0
    }
    frame.self += self.get(node.id) ?? 0
    frame.total += total.get(node.id) ?? 0
    frames.set(key, frame)
  }
  const duration = [...self.values()].reduce((sum, value) => sum + value, 0)
  const percent = (value: number): string => `${(duration ? value / duration * 100 : 0).toFixed(2)}%`
  const table = (key: 'self' | 'total', count: number): string => {
    const rows = [['functionName', 'url:line', `${key} ms`, `${key} %`], ...[...frames.values()]
      .sort((a, b) => b[key] - a[key]).slice(0, count)
      .map((frame) => [frame.name, frame.location, (frame[key] / 1000).toFixed(2), percent(frame[key])])]
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
    return rows.map((row) => row.map((cell, i) => i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join('  ').trimEnd()).join('\n')
  }
  const shares = ['(program)', '(garbage collector)', '(idle)'].map((name) => {
    const time = [...frames.values()].filter((frame) => frame.name === name).reduce((sum, frame) => sum + frame.self, 0)
    return `${name}: ${(time / 1000).toFixed(2)} ms (${percent(time)})`
  })
  return [`Sampled time: ${(duration / 1000).toFixed(2)} ms (${profile.samples.length} samples)`,
    'Top 30 by self time', table('self', 30), 'Special frames', ...shares,
    'Top 15 by total time (self + descendants)', table('total', 15)].join('\n')
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: bun scripts/profile-summary.ts <file.cpuprofile>')
    process.exit(1)
  }
  console.log(profileSummary(JSON.parse(readFileSync(file, 'utf8'))))
}
