import { expect, it } from 'vitest'
import { installWarningLog } from './warningLog'

it('a Node warning reaches the log with its name, its message and its stack', async () => {
  const lines: unknown[][] = []
  const off = installWarningLog((...parts) => lines.push(parts))
  process.emitWarning('eleven abort listeners added to [AbortSignal]', 'MaxListenersExceededWarning')
  await new Promise((r) => setImmediate(r))
  off()
  const line = lines.find((parts) => parts[1] === 'MaxListenersExceededWarning')
  expect(line).toBeDefined()
  expect(line![0]).toBe('[warn]')
  expect(line![2]).toBe('eleven abort listeners added to [AbortSignal]')
  expect(String(line![4])).toContain('warningLog.test.ts')
  // Uninstalled: a later warning is nobody's.
  const before = lines.length
  process.emitWarning('again', 'TestWarning')
  await new Promise((r) => setImmediate(r))
  expect(lines.length).toBe(before)
})
