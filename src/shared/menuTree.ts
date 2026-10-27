/**
 * The application menu as data, the one table main's native menu
 * (src/main/menu.ts), the in-app bar of a browser on /ui
 * (chrome/MenuBar.tsx) and the tests read. Free of Electron imports.
 *
 * Ids double as command ids in the renderer's command map
 * (src/renderer/src/lib/appCommands.ts); `MAIN_MENU_IDS` act in main.
 * A window keeps the labels and greyed rows in step with what it shows
 * by sending its `MenuState` over `menu:state`; `resolveMenu` applies it.
 */

export const APP_NAME = 'TempCode'

export interface MenuCommand {
  kind: 'command'
  id: string
  label: string
  accelerator?: string
  /** Shown in the menu but left to the page: the menu does not register the key. */
  pageKey?: true
  /** Hidden from the in-app bar of a browser (/ui has no second window and no terminal). */
  desktopOnly?: true
  /** Show/Hide labels; `label` is the show one. */
  toggle?: { show: string; hide: string }
  /** Set by `resolveMenu` only. */
  enabled?: boolean
}

export interface MenuRole {
  kind: 'role'
  role: string
  label?: string
  accelerator?: string
}

export interface MenuSubmenu {
  kind: 'submenu'
  label: string
  items: MenuNode[]
}

export type MenuNode = { kind: 'separator' } | MenuRole | MenuCommand | MenuSubmenu

export interface MenuSection {
  label: string
  role?: 'windowMenu' | 'help'
  items: MenuNode[]
}

const sep: MenuNode = { kind: 'separator' }
const role = (name: string, label?: string, accelerator?: string): MenuRole => ({
  kind: 'role',
  role: name,
  ...(label ? { label } : {}),
  ...(accelerator ? { accelerator } : {})
})
const cmd = (
  id: string,
  label: string,
  accelerator?: string,
  extra: Pick<MenuCommand, 'pageKey' | 'desktopOnly'> = {}
): MenuCommand => ({ kind: 'command', id, label, ...(accelerator ? { accelerator } : {}), ...extra })
const toggle = (id: string, what: string, accelerator: string, extra: Pick<MenuCommand, 'desktopOnly'> = {}): MenuCommand => ({
  ...cmd(id, `Show ${what}`, accelerator, extra),
  toggle: { show: `Show ${what}`, hide: `Hide ${what}` }
})
const submenu = (label: string, items: MenuNode[]): MenuSubmenu => ({ kind: 'submenu', label, items })

export const MENU_TREE: MenuSection[] = [
  {
    label: APP_NAME,
    items: [
      role('about'),
      cmd('check_for_updates', 'Check for Updates…'),
      sep,
      cmd('open_settings', 'Settings…', 'CmdOrCtrl+,'),
      sep,
      role('services'),
      sep,
      role('hide'),
      role('hideOthers'),
      role('unhide'),
      sep,
      cmd('quit', `Quit ${APP_NAME}`, 'CmdOrCtrl+Q')
    ]
  },
  {
    label: 'File',
    items: [
      cmd('new_tab', 'New Thread', 'CmdOrCtrl+N'),
      cmd('new_terminal', 'New Terminal', 'Ctrl+`', { pageKey: true, desktopOnly: true }),
      cmd('new_window', 'New Window', 'CmdOrCtrl+Shift+N', { desktopOnly: true }),
      sep,
      cmd('open_project', 'Open Project…', 'CmdOrCtrl+O'),
      sep,
      cmd('save_all', 'Save All', 'CmdOrCtrl+S'),
      sep,
      cmd('close_tab', 'Close Pane', 'CmdOrCtrl+W'),
      role('close', 'Close Window', 'CmdOrCtrl+Shift+W')
    ]
  },
  {
    label: 'Edit',
    items: [
      role('undo'),
      role('redo'),
      sep,
      role('cut'),
      role('copy'),
      role('paste'),
      role('selectAll'),
      sep,
      cmd('find', 'Find…', 'CmdOrCtrl+F'),
      cmd('find_in_project', 'Find in Files…', 'CmdOrCtrl+Shift+F')
    ]
  },
  {
    label: 'View',
    items: [
      toggle('toggle_sidebar', 'Sidebar', 'CmdOrCtrl+B'),
      toggle('toggle_panel', 'Panel', 'CmdOrCtrl+Shift+R'),
      toggle('toggle_terminal', 'Terminal', 'CmdOrCtrl+J', { desktopOnly: true }),
      sep,
      cmd('split_right', 'Split Right', 'CmdOrCtrl+D'),
      cmd('split_down', 'Split Down', 'CmdOrCtrl+Shift+D'),
      submenu('Focus Pane', [
        cmd('focus_left', 'Left', 'CmdOrCtrl+Alt+Left'),
        cmd('focus_right', 'Right', 'CmdOrCtrl+Alt+Right'),
        cmd('focus_up', 'Up', 'CmdOrCtrl+Alt+Up'),
        cmd('focus_down', 'Down', 'CmdOrCtrl+Alt+Down')
      ]),
      sep,
      role('reload', 'Reload Window'),
      // No key: Electron's forceReload role brings ⇧⌘R, which Show Panel owns.
      cmd('force_reload', 'Force Reload'),
      sep,
      cmd('zoom_in', 'Zoom In', 'CmdOrCtrl+='),
      cmd('zoom_out', 'Zoom Out', 'CmdOrCtrl+-'),
      cmd('zoom_reset', 'Actual Size', 'CmdOrCtrl+0')
    ]
  },
  {
    label: 'Go',
    items: [
      cmd('open_search', 'Search…', 'CmdOrCtrl+K'),
      cmd('go_to_file', 'Go to File…', 'CmdOrCtrl+P'),
      cmd('go_to_symbol', 'Go to Symbol…', 'CmdOrCtrl+Shift+O'),
      cmd('show_hierarchy', 'Type Hierarchy', 'CmdOrCtrl+T'),
      sep,
      cmd('back_tab', 'Back', 'CmdOrCtrl+['),
      cmd('forward_tab', 'Forward', 'CmdOrCtrl+]'),
      sep,
      cmd('prev_tab', 'Previous Tab', 'CmdOrCtrl+Shift+['),
      cmd('next_tab', 'Next Tab', 'CmdOrCtrl+Shift+]'),
      sep,
      cmd('prev_environment', 'Previous Host', 'CmdOrCtrl+Alt+['),
      cmd('next_environment', 'Next Host', 'CmdOrCtrl+Alt+]'),
      sep,
      cmd('open_inbox', 'Inbox'),
      cmd('open_notes', 'Notes')
    ]
  },
  {
    label: 'Threads',
    items: [
      cmd('open_model_picker', 'Switch Model…', 'CmdOrCtrl+.'),
      sep,
      cmd('mark_all_read', 'Mark All Read'),
      sep,
      cmd('pause_all_threads', 'Pause All'),
      cmd('resume_all_threads', 'Resume All'),
      cmd('stop_all_threads', 'Stop All'),
      cmd('archive_done_threads', 'Archive Done')
    ]
  },
  { label: 'Window', role: 'windowMenu', items: [] },
  {
    label: 'Help',
    role: 'help',
    items: [
      cmd('whats_new', "What's New"),
      sep,
      cmd('show_logs', 'Show Logs'),
      cmd('profile_host', 'Profile the Host for 10 Seconds'),
      role('toggleDevTools', 'Developer Tools', 'Alt+CmdOrCtrl+I')
    ]
  }
]

/** Every command node of a list, submenus included, in menu order. */
export function commandsOf(items: MenuNode[]): MenuCommand[] {
  return items.flatMap((item) =>
    item.kind === 'command' ? [item] : item.kind === 'submenu' ? commandsOf(item.items) : []
  )
}

/** Every custom item, in menu order. */
export const MENU_COMMANDS: MenuCommand[] = MENU_TREE.flatMap((section) => commandsOf(section.items))

/** Quit, the logs, profiling and Force Reload act in main (a hung renderer
 *  cannot reload itself); other commands go to the focused renderer (New
 *  Window falls back to main only when no window is there to take it). */
export const MAIN_MENU_IDS = ['quit', 'profile_host', 'show_logs', 'force_reload'] as const

export const RENDERER_MENU_IDS: string[] = MENU_COMMANDS.map((c) => c.id).filter(
  (id) => !(MAIN_MENU_IDS as readonly string[]).includes(id)
)

/** What a window tells main: the toggles that are open and the items that would do nothing. */
export interface MenuState {
  open: string[]
  disabled: string[]
}

export const EMPTY_MENU_STATE: MenuState = { open: [], disabled: [] }

export function sameMenuState(a: MenuState, b: MenuState): boolean {
  const same = (x: string[], y: string[]): boolean =>
    x.length === y.length && [...x].sort().join('\n') === [...y].sort().join('\n')
  return same(a.open, b.open) && same(a.disabled, b.disabled)
}

function resolveNodes(items: MenuNode[], state: MenuState): MenuNode[] {
  return items.map((item) => {
    if (item.kind === 'submenu') return { ...item, items: resolveNodes(item.items, state) }
    if (item.kind !== 'command') return item
    const label = item.toggle && state.open.includes(item.id) ? item.toggle.hide : item.label
    return { ...item, label, enabled: !state.disabled.includes(item.id) }
  })
}

/** The tree as a window in `state` reads it: open toggles say Hide, disabled ids are greyed. */
export function resolveMenu(tree: MenuSection[], state: MenuState): MenuSection[] {
  return tree.map((section) => ({ ...section, items: resolveNodes(section.items, state) }))
}

export type InAppItem = { kind: 'separator' } | { kind: 'item'; id: string; label: string; accelerator?: string }

export interface InAppMenu {
  label: string
  items: InAppItem[]
}

/** The menus of the in-app bar: the tree's command rows a page can run (no roles, no
 *  main ids, nothing desktop-only), toggles under their show label, a submenu's rows
 *  inline under its name; the app menu, Window and anything left empty go. */
export function inAppMenus(tree: MenuSection[]): InAppMenu[] {
  const main = MAIN_MENU_IDS as readonly string[]
  const rows = (items: MenuNode[], prefix = ''): InAppItem[] =>
    items.flatMap((item): InAppItem[] => {
      if (item.kind === 'separator') return [item]
      if (item.kind === 'submenu') return rows(item.items, `${prefix}${item.label} `)
      if (item.kind !== 'command' || main.includes(item.id) || item.desktopOnly) return []
      return [
        {
          kind: 'item',
          id: item.id,
          label: `${prefix}${item.label}`,
          ...(item.accelerator ? { accelerator: item.accelerator } : {})
        }
      ]
    })
  return tree
    .filter((section) => section.label !== APP_NAME && !section.role)
    .map((section) => ({
      label: section.label,
      // Separators only between rows: none leading, trailing or doubled.
      items: rows(section.items).filter(
        (item, i, all) =>
          item.kind === 'item' || (i > 0 && all[i - 1].kind === 'item' && all.slice(i + 1).some((n) => n.kind === 'item'))
      )
    }))
    .filter((menu) => menu.items.length > 0)
}
