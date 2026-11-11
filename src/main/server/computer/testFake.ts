import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let binary: string | undefined

/** A launcher for the Node-only fake; each test process shares one wrapper. */
export function fakeServiceBin(): string {
  if (binary) return binary
  const dir = mkdtempSync(join(tmpdir(), 'tc-computer-fake-'))
  const script = fileURLToPath(new URL('./fakeService.mjs', import.meta.url))
  // Quote shell metacharacters even when a checkout path contains them.
  const quote = (value: string): string => '"' + value.replace(/["\\$`]/g, '\\$&') + '"'
  binary = join(dir, 'tc-computer')
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
  chmodSync(binary, 0o755)
  return binary
}

export const FAKE_APPS = {
  TextEdit: { name: 'TextEdit', pid: 16800, bundleId: 'com.apple.TextEdit', windowId: 1581 },
  Thin: { name: 'Thin', pid: 16801, bundleId: 'dev.fake.thin', windowId: 168010 },
  KeyWin: { name: 'KeyWin', pid: 16802, bundleId: 'dev.fake.keywin', windowId: 168020 },
  Sessiony: { name: 'Sessiony', pid: 16803, bundleId: 'dev.fake.sessiony', windowId: 168030 },
  Stubborn: { name: 'Stubborn', pid: 16804, bundleId: 'dev.fake.stubborn', windowId: 168040 },
  Slow: { name: 'Slow', pid: 16805, bundleId: 'dev.fake.slow', windowId: 168050 },
  Crashy: { name: 'Crashy', pid: 16806, bundleId: 'dev.fake.crashy', windowId: 168060 },
  NoAX: { name: 'NoAX', pid: 16807, bundleId: 'dev.fake.noax', windowId: 168070 },
  NoShot: { name: 'NoShot', pid: 16808, bundleId: 'dev.fake.noshot', windowId: 168080 },
  Touchy: { name: 'Touchy', pid: 16809, bundleId: 'dev.fake.touchy', windowId: 168090 },
  Menuey: { name: 'Menuey', pid: 16810, bundleId: 'dev.fake.menuey', windowId: 168100 },
  Webby: { name: 'Webby', pid: 17100, bundleId: 'dev.fake.webby', windowId: 171000 },
  Hitty: { name: 'Hitty', pid: 16811, bundleId: 'dev.fake.hitty', windowId: 168110 },
  Closey: { name: 'Closey', pid: 16900, bundleId: 'dev.fake.closey', windowId: 169000 },
  Preview: { name: 'Preview', pid: 17000, bundleId: 'com.apple.Preview', windowId: 170000 },
  Fronty: { name: 'Fronty', pid: 17200, bundleId: 'dev.fake.fronty', windowId: 172000 },
  Committy: { name: 'Committy', pid: 17201, bundleId: 'dev.fake.committy', windowId: 172010 },
  Panely: { name: 'Panely', pid: 17202, bundleId: 'dev.fake.panely', windowId: 172020 },
  Menuy: { name: 'Menuy', pid: 17203, bundleId: 'dev.fake.menuy', windowId: 172030 },
  Finder: { name: 'Finder', pid: 400, bundleId: 'com.apple.finder', windowId: null },
  // §27's scenarios (fakeService.mjs FEWER)
  Menuful: { name: 'Menuful', pid: 16820, bundleId: 'dev.fake.menuful', windowId: 168200 },
  Newdoc: { name: 'Newdoc', pid: 16821, bundleId: 'dev.fake.newdoc', windowId: 168210 },
  Renamey: { name: 'Renamey', pid: 16822, bundleId: 'dev.fake.renamey', windowId: 168220 },
  Blindy: { name: 'Blindy', pid: 16823, bundleId: 'dev.fake.blindy', windowId: 168230 },
  Unplanned: { name: 'Unplanned', pid: 16824, bundleId: 'dev.fake.unplanned', windowId: 168240 },
  Secret: { name: 'Secret', pid: 16825, bundleId: 'dev.fake.secret', windowId: 168250 },
  Splitty: { name: 'Splitty', pid: 16826, bundleId: 'dev.fake.splitty', windowId: 168260 }
} as const

/** A hand-turned clock for the host's own timers; the fake's and the connection's stay real. */
export class ManualClock {
  t = 1_000_000
  private timers: { at: number; fn: () => void; id: number }[] = []
  private next = 0
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.next
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== id)
  }
  async advance(ms: number): Promise<void> {
    const until = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const due = this.timers[0]
      if (!due || due.at > until) break
      this.timers.shift()
      this.t = due.at
      due.fn()
      await settle()
    }
    this.t = until
    await settle()
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}
