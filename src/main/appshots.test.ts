import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('./windows', () => ({ targetWindow: vi.fn(() => null) }))

const { appshotReady } = await import('./appshots')

it('a window announcing appshot-ready any number of times is watched for its end once', () => {
  const destroyed: (() => void)[] = []
  const sent: unknown[] = []
  const sender = {
    id: 7,
    once: vi.fn((_event: 'destroyed', fn: () => void) => destroyed.push(fn)),
    send: vi.fn((_channel: string, payload: unknown) => sent.push(payload))
  }
  for (let i = 0; i < 12; i++) appshotReady(sender)
  expect(sender.once).toHaveBeenCalledTimes(1)
  expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  // Gone and back (a reload lands a new announcement from a new id; the same id is watched afresh once forgotten).
  destroyed[0]()
  appshotReady(sender)
  expect(sender.once).toHaveBeenCalledTimes(2)
  expect(sent).toEqual([])
})
