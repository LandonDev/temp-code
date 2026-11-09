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
  Preview: { name: 'Preview', pid: 17000, bundleId: 'com.apple.Preview', windowId: 170000 },
  Finder: { name: 'Finder', pid: 400, bundleId: 'com.apple.finder', windowId: null }
} as const
