import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { hostProfileRunning, profileHost } from './server/doctorProfile'
import { buildMenu } from './menu'

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('./windows', () => ({ createWindow: vi.fn() }))
vi.mock('./server/doctorProfile', () => ({ hostProfileRunning: vi.fn(), profileHost: vi.fn() }))

function clickProfile(): void {
  buildMenu()
  const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0]
  const help = template.find((section) => section.label === 'Help')!
  const item = (help.submenu as MenuItemConstructorOptions[]).find((row) => row.id === 'profile_host')!
  expect(item.label).toBe('Profile the host (10 s)')
  ;(item.click as () => void)()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hostProfileRunning).mockReturnValue(false)
})

describe('host profile menu', () => {
  it('calls the shared profiler and reveals the file after it finishes', async () => {
    let finish!: (result: Awaited<ReturnType<typeof profileHost>>) => void
    vi.mocked(profileHost).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    clickProfile()
    expect(profileHost).toHaveBeenCalledWith({ seconds: 10 })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    finish({ path: '/tmp/host.cpuprofile', bytes: 123, seconds: 10, samples: 10 })
    await vi.waitFor(() => expect(shell.showItemInFolder).toHaveBeenCalledWith('/tmp/host.cpuprofile'))
    expect(BrowserWindow.getFocusedWindow).not.toHaveBeenCalled()
  })

  it('ignores a click while a profile is running', () => {
    vi.mocked(hostProfileRunning).mockReturnValue(true)
    clickProfile()
    expect(profileHost).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('logs one doctor line on error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(profileHost).mockRejectedValue(new Error('capture\nfailed'))
      clickProfile()
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1))
      expect(log).toHaveBeenCalledWith('[doctor] Error: capture failed')
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
