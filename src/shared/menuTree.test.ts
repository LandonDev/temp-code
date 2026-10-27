import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  MAIN_MENU_IDS,
  MENU_COMMANDS,
  MENU_TREE,
  RENDERER_MENU_IDS,
  inAppMenus,
  resolveMenu,
  sameMenuState,
  type MenuNode
} from './menuTree'

/** What Electron gives a role when the tree names none (macOS). */
const ROLE_DEFAULTS: Record<string, [string, string?]> = {
  about: [`About ${APP_NAME}`],
  services: ['Services'],
  hide: [`Hide ${APP_NAME}`, 'Cmd+H'],
  hideOthers: ['Hide Others', 'Alt+Cmd+H'],
  unhide: ['Show All'],
  undo: ['Undo', 'Cmd+Z'],
  redo: ['Redo', 'Shift+Cmd+Z'],
  cut: ['Cut', 'Cmd+X'],
  copy: ['Copy', 'Cmd+C'],
  paste: ['Paste', 'Cmd+V'],
  selectAll: ['Select All', 'Cmd+A'],
  close: ['Close', 'Cmd+W'],
  reload: ['Reload', 'Cmd+R'],
  toggleDevTools: ['Toggle Developer Tools', 'Alt+Cmd+I']
}

/** The window menu's own chord on macOS. */
const WINDOW_MENU_CHORDS = ['Cmd+M']

/** Chords macOS keeps for itself. */
const RESERVED = ['Cmd+`', 'Shift+Cmd+`', 'Cmd+Tab', 'Cmd+Space', 'Shift+Cmd+/', 'Ctrl+Cmd+F', 'Ctrl+Cmd+Q', 'Alt+Cmd+D', 'Alt+Cmd+Escape', 'Shift+Cmd+3', 'Shift+Cmd+4', 'Shift+Cmd+5']

/** One spelling per chord: modifiers sorted, CmdOrCtrl read as macOS reads it. */
function chord(accelerator: string): string {
  const parts = accelerator.split('+').map((p) => (p === 'CmdOrCtrl' || p === 'CommandOrControl' ? 'Cmd' : p === 'Option' ? 'Alt' : p))
  const key = parts.pop()!
  const order = ['Ctrl', 'Alt', 'Shift', 'Cmd']
  return [...parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)), key].join('+')
}

type Row = [string, string?] | '—' | [string, Row[]]

function rows(items: MenuNode[]): Row[] {
  return items.map((item): Row => {
    if (item.kind === 'separator') return '—'
    if (item.kind === 'submenu') return [item.label, rows(item.items)]
    if (item.kind === 'role') {
      const [label, key] = ROLE_DEFAULTS[item.role] ?? [item.role]
      const accelerator = item.accelerator ?? key
      return accelerator ? [item.label ?? label, chord(accelerator)] : [item.label ?? label]
    }
    return item.accelerator ? [item.label, chord(item.accelerator)] : [item.label]
  })
}

function chords(items: MenuNode[]): string[] {
  return rows(items).flatMap(function flat(row): string[] {
    if (row === '—') return []
    if (Array.isArray(row[1])) return (row[1] as Row[]).flatMap(flat)
    return row[1] ? [row[1] as string] : []
  })
}

const section = (label: string): Row[] => rows(MENU_TREE.find((s) => s.label === label)!.items)

describe('menu tree', () => {
  it('names the menus in order', () => {
    expect(MENU_TREE.map((s) => s.label)).toEqual([APP_NAME, 'File', 'Edit', 'View', 'Go', 'Threads', 'Window', 'Help'])
    expect(MENU_TREE.find((s) => s.label === 'Window')!.role).toBe('windowMenu')
  })

  it('reads every row of every menu as the table says', () => {
    expect(section(APP_NAME)).toEqual([
      ['About TempCode'],
      ['Check for Updates…'],
      '—',
      ['Settings…', 'Cmd+,'],
      '—',
      ['Services'],
      '—',
      ['Hide TempCode', 'Cmd+H'],
      ['Hide Others', 'Alt+Cmd+H'],
      ['Show All'],
      '—',
      ['Quit TempCode', 'Cmd+Q']
    ])
    expect(section('File')).toEqual([
      ['New Thread', 'Cmd+N'],
      ['New Terminal', 'Ctrl+`'],
      ['New Window', 'Shift+Cmd+N'],
      '—',
      ['Open Project…', 'Cmd+O'],
      '—',
      ['Save All', 'Cmd+S'],
      '—',
      ['Close Pane', 'Cmd+W'],
      ['Close Window', 'Shift+Cmd+W']
    ])
    expect(section('Edit')).toEqual([
      ['Undo', 'Cmd+Z'],
      ['Redo', 'Shift+Cmd+Z'],
      '—',
      ['Cut', 'Cmd+X'],
      ['Copy', 'Cmd+C'],
      ['Paste', 'Cmd+V'],
      ['Select All', 'Cmd+A'],
      '—',
      ['Find…', 'Cmd+F'],
      ['Find in Files…', 'Shift+Cmd+F']
    ])
    expect(section('View')).toEqual([
      ['Show Sidebar', 'Cmd+B'],
      ['Show Panel', 'Shift+Cmd+R'],
      ['Show Terminal', 'Cmd+J'],
      '—',
      ['Split Right', 'Cmd+D'],
      ['Split Down', 'Shift+Cmd+D'],
      ['Focus Pane', [['Left', 'Alt+Cmd+Left'], ['Right', 'Alt+Cmd+Right'], ['Up', 'Alt+Cmd+Up'], ['Down', 'Alt+Cmd+Down']]],
      '—',
      ['Reload Window', 'Cmd+R'],
      ['Force Reload'],
      '—',
      ['Zoom In', 'Cmd+='],
      ['Zoom Out', 'Cmd+-'],
      ['Actual Size', 'Cmd+0']
    ])
    expect(section('Go')).toEqual([
      ['Search…', 'Cmd+K'],
      ['Go to File…', 'Cmd+P'],
      ['Go to Symbol…', 'Shift+Cmd+O'],
      ['Type Hierarchy', 'Cmd+T'],
      '—',
      ['Back', 'Cmd+['],
      ['Forward', 'Cmd+]'],
      '—',
      ['Previous Tab', 'Shift+Cmd+['],
      ['Next Tab', 'Shift+Cmd+]'],
      '—',
      ['Previous Host', 'Alt+Cmd+['],
      ['Next Host', 'Alt+Cmd+]'],
      '—',
      ['Inbox'],
      ['Notes']
    ])
    expect(section('Threads')).toEqual([
      ['Switch Model…', 'Cmd+.'],
      '—',
      ['Mark All Read'],
      '—',
      ['Pause All'],
      ['Resume All'],
      ['Stop All'],
      ['Archive Done']
    ])
    expect(section('Window')).toEqual([])
    expect(section('Help')).toEqual([["What's New"], '—', ['Show Logs'], ['Profile the Host for 10 Seconds'], ['Developer Tools', 'Alt+Cmd+I']])
  })

  it('gives Open Project ⌘O, the key the renderer\'s resolver maps to it, and Go to Symbol ⌘⇧O', () => {
    expect(MENU_COMMANDS.find((c) => c.id === 'open_project')!.accelerator).toBe('CmdOrCtrl+O')
    expect(MENU_COMMANDS.find((c) => c.id === 'go_to_symbol')!.accelerator).toBe('CmdOrCtrl+Shift+O')
  })

  it('runs Force Reload as its own keyless command, never the role that brings ⇧⌘R, and has no Appearance… or New Terminal Tab', () => {
    const roles = MENU_TREE.flatMap((s) => s.items).filter((i) => i.kind === 'role').map((i) => (i as { role: string }).role)
    expect(roles).not.toContain('forceReload')
    expect(MENU_COMMANDS.find((c) => c.id === 'force_reload')?.accelerator).toBeUndefined()
    expect(MENU_COMMANDS.map((c) => c.id)).not.toContain('sidebar_opacity')
    expect(MENU_COMMANDS.map((c) => c.id)).not.toContain('new_terminal_tab')
  })

  it('leaves New Terminal to the page', () => {
    const item = MENU_COMMANDS.find((c) => c.id === 'new_terminal')!
    expect(item.pageKey).toBe(true)
  })

  it('has no duplicate ids', () => {
    const ids = MENU_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives no two items one chord, the roles and the window menu included', () => {
    const all = [...MENU_TREE.flatMap((s) => chords(s.items)), ...WINDOW_MENU_CHORDS]
    const seen = new Map<string, number>()
    for (const c of all) seen.set(c, (seen.get(c) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1)).toEqual([])
  })

  it('takes no chord macOS keeps for itself', () => {
    const all = MENU_TREE.flatMap((s) => chords(s.items))
    expect(all.filter((c) => RESERVED.includes(c))).toEqual([])
  })

  it('gives every toggle both labels', () => {
    const toggles = MENU_COMMANDS.filter((c) => c.toggle)
    expect(toggles.map((c) => c.id)).toEqual(['toggle_sidebar', 'toggle_panel', 'toggle_terminal'])
    for (const c of toggles) {
      expect(c.toggle!.show).toMatch(/^Show /)
      expect(c.toggle!.hide).toMatch(/^Hide /)
      expect(c.label).toBe(c.toggle!.show)
    }
  })

  it('keeps quit, the logs, profiling and Force Reload in main', () => {
    expect(MAIN_MENU_IDS).toEqual(['quit', 'profile_host', 'show_logs', 'force_reload'])
    expect(RENDERER_MENU_IDS).toContain('whats_new')
    expect(RENDERER_MENU_IDS).toContain('new_window')
    for (const id of MAIN_MENU_IDS) expect(RENDERER_MENU_IDS).not.toContain(id)
  })
})

describe('resolveMenu', () => {
  const find = (tree: ReturnType<typeof resolveMenu>, id: string) =>
    tree.flatMap((s) => s.items).flatMap((i) => (i.kind === 'submenu' ? i.items : [i])).find((i) => i.kind === 'command' && i.id === id) as { label: string; enabled?: boolean }

  it('relabels an open toggle and greys a disabled id', () => {
    const tree = resolveMenu(MENU_TREE, { open: ['toggle_sidebar'], disabled: ['pause_all_threads', 'focus_left'] })
    expect(find(tree, 'toggle_sidebar').label).toBe('Hide Sidebar')
    expect(find(tree, 'toggle_panel').label).toBe('Show Panel')
    expect(find(tree, 'pause_all_threads').enabled).toBe(false)
    expect(find(tree, 'focus_left').enabled).toBe(false)
    expect(find(tree, 'stop_all_threads').enabled).toBe(true)
  })

  it('leaves the tree itself alone', () => {
    resolveMenu(MENU_TREE, { open: ['toggle_sidebar'], disabled: [] })
    expect(MENU_COMMANDS.find((c) => c.id === 'toggle_sidebar')!.label).toBe('Show Sidebar')
  })

  it('compares states without order', () => {
    expect(sameMenuState({ open: ['a', 'b'], disabled: [] }, { open: ['b', 'a'], disabled: [] })).toBe(true)
    expect(sameMenuState({ open: ['a'], disabled: [] }, { open: ['a'], disabled: ['b'] })).toBe(false)
  })
})

describe('inAppMenus', () => {
  const menus = inAppMenus(MENU_TREE)
  const ids = menus.flatMap((m) => m.items.flatMap((i) => (i.kind === 'item' ? [i.id] : [])))

  it('lists File, Edit, View, Go and Threads', () => {
    expect(menus.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Go', 'Threads'])
  })

  it('drops roles, main ids and desktop-only rows', () => {
    for (const id of [...MAIN_MENU_IDS, 'new_window', 'new_terminal', 'toggle_terminal']) expect(ids).not.toContain(id)
    const labels = menus.flatMap((m) => m.items.flatMap((i) => (i.kind === 'item' ? [i.label] : [])))
    for (const label of ['Undo', 'Close Window', 'Reload Window', 'Developer Tools']) expect(labels).not.toContain(label)
  })

  it('reads toggles as Show, puts a submenu inline and keeps separators between rows only', () => {
    const view = menus.find((m) => m.label === 'View')!
    expect(view.items.find((i) => i.kind === 'item' && i.id === 'toggle_sidebar')).toEqual({ kind: 'item', id: 'toggle_sidebar', label: 'Show Sidebar', accelerator: 'CmdOrCtrl+B' })
    expect(view.items.find((i) => i.kind === 'item' && i.id === 'focus_left')).toMatchObject({ label: 'Focus Pane Left' })
    const edit = menus.find((m) => m.label === 'Edit')!
    expect(edit.items.map((i) => (i.kind === 'item' ? i.id : '—'))).toEqual(['find', 'find_in_project'])
    for (const menu of menus) {
      expect(menu.items[0].kind).toBe('item')
      expect(menu.items.at(-1)!.kind).toBe('item')
      menu.items.forEach((item, i) => {
        if (item.kind === 'separator') expect(menu.items[i - 1].kind).toBe('item')
      })
    }
  })
})
