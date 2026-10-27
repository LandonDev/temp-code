import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { hostProfileRunning, profileHost } from './server/doctorProfile'
import { buildMenu } from './menu'

vi.mock('electron', () => ({
  app: { quit: vi.fn(), getPath: vi.fn(), on: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn() },
  ipcMain: { on: vi.fn() },
  globalShortcut: { isRegistered: vi.fn(), register: vi.fn(), unregister: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))
vi.mock('./windows', () => ({ createWindow: vi.fn() }))
vi.mock('./server/doctorProfile', () => ({ hostProfileRunning: vi.fn(), profileHost: vi.fn() }))

function template(): MenuItemConstructorOptions[] {
  buildMenu()
  return vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
}

function menu(label: string): MenuItemConstructorOptions[] {
  return template().find((section) => section.label === label)!.submenu as MenuItemConstructorOptions[]
}

function clickProfile(): void {
  const item = menu('Help').find((row) => row.id === 'profile_host')!
  expect(item.label).toBe('Profile the Host for 10 Seconds')
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

describe('menu template', () => {
  it('carries the Focus Pane submenu with its items', () => {
    const focus = menu('View').find((row) => row.label === 'Focus Pane')!
    const rows = focus.submenu as MenuItemConstructorOptions[]
    expect(rows.map((r) => [r.id, r.label, r.accelerator])).toEqual([
      ['focus_left', 'Left', 'CmdOrCtrl+Alt+Left'],
      ['focus_right', 'Right', 'CmdOrCtrl+Alt+Right'],
      ['focus_up', 'Up', 'CmdOrCtrl+Alt+Up'],
      ['focus_down', 'Down', 'CmdOrCtrl+Alt+Down']
    ])
  })

  it('passes the role overrides', () => {
    expect(menu('File').find((r) => r.role === 'close')).toEqual({ role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' })
    expect(menu('View').find((r) => r.role === 'reload')).toEqual({ role: 'reload', label: 'Reload Window' })
    expect(menu('Help').find((r) => r.role === 'toggleDevTools')).toEqual({ role: 'toggleDevTools', label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I' })
    expect(menu('Edit').find((r) => r.role === 'undo')).toEqual({ role: 'undo' })
  })

  it('shows New Terminal\'s key without registering it', () => {
    const item = menu('File').find((r) => r.id === 'new_terminal')!
    expect(item.accelerator).toBe('Ctrl+`')
    expect(item.registerAccelerator).toBe(false)
    expect(menu('File').find((r) => r.id === 'new_tab')!.registerAccelerator).toBeUndefined()
  })

  it('leaves New Terminal\'s key to the page on macOS too, where the key still reaches the menu', () => {
    const send = vi.fn()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue({ isDestroyed: () => false, webContents: { send } } as never)
    const click = menu('File').find((r) => r.id === 'new_terminal')!.click as (...args: unknown[]) => void
    click({}, undefined, { triggeredByAccelerator: true, ctrlKey: true })
    expect(send).not.toHaveBeenCalled()
    click({}, undefined, { triggeredByAccelerator: false })
    expect(send).toHaveBeenCalledTimes(1)
    // Return on the item while navigating the menu by keyboard.
    click({}, undefined, { triggeredByAccelerator: true, ctrlKey: false })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('native:menu', 'new_terminal')
  })
})

describe('show logs', () => {
  it('opens the logs directory, making it first', () => {
    const userData = mkdtempSync(join(tmpdir(), 'menu-logs-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
    const item = menu('Help').find((row) => row.id === 'show_logs')!
    expect(item.label).toBe('Show Logs')
    ;(item.click as () => void)()
    expect(existsSync(join(userData, 'logs'))).toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith(join(userData, 'logs'))
    expect(BrowserWindow.getFocusedWindow).not.toHaveBeenCalled()
  })
})

describe('menu state', () => {
  type Contents = { id: number; once: (event: string, cb: () => void) => void; destroy: () => void }
  function contents(id: number): Contents {
    let onDestroyed = (): void => {}
    return { id, once: (_event, cb) => { onDestroyed = cb }, destroy: () => onDestroyed() }
  }
  const windowOf = (c: Contents) => ({ webContents: c, isDestroyed: () => false }) as unknown as BrowserWindow
  const row = (section: string, id: string): MenuItemConstructorOptions => {
    const last = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
    const items = last.find((s) => s.label === section)!.submenu as MenuItemConstructorOptions[]
    return items.find((r) => r.id === id)!
  }
  let menuModule: typeof import('./menu')

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({} as Menu)
    menuModule = await import('./menu')
    menuModule.registerMenu()
  })

  it('takes the focused window\'s state: Hide Sidebar, Pause All greyed', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    expect(row('View', 'toggle_sidebar').label).toBe('Show Sidebar')
    menuModule.receiveMenuState(c as never, { open: ['toggle_sidebar'], disabled: ['pause_all_threads'] })
    expect(row('View', 'toggle_sidebar').label).toBe('Hide Sidebar')
    expect(row('Threads', 'pause_all_threads').enabled).toBe(false)
    expect(row('Threads', 'stop_all_threads').enabled).toBeUndefined()
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it('holds a blurred window\'s state until that window is focused', () => {
    const front = contents(1)
    const back = contents(2)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(front))
    menuModule.receiveMenuState(back as never, { open: ['toggle_terminal'], disabled: [] })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(back))
    const calls = vi.mocked(app.on).mock.calls as unknown as [string, () => void][]
    const onFocus = calls.find(([event]) => event === 'browser-window-focus')![1]
    onFocus()
    expect(row('View', 'toggle_terminal').label).toBe('Hide Terminal')
  })

  it('does not rebuild for a state it already shows', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    menuModule.receiveMenuState(c as never, { open: ['toggle_panel'], disabled: [] })
    menuModule.receiveMenuState(c as never, { open: ['toggle_panel'], disabled: [] })
    menuModule.applyFocusedMenu()
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it('goes back to the plain menu when the window closes', () => {
    const c = contents(1)
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(windowOf(c))
    menuModule.receiveMenuState(c as never, { open: ['toggle_sidebar'], disabled: [] })
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null)
    c.destroy()
    expect(row('View', 'toggle_sidebar').label).toBe('Show Sidebar')
  })

  it('listens on menu:state', () => {
    expect(vi.mocked(ipcMain.on).mock.calls.map(([channel]) => channel)).toContain('menu:state')
  })
})
