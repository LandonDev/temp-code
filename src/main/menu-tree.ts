/**
 * The application menu as data: MonoCode's tree (`src-tauri/src/menu.rs`)
 * with its accelerators, under our own name. Kept free of Electron imports
 * so the table can be tested on its own.
 *
 * Ids double as command ids in the renderer's command map
 * (src/renderer/src/lib/appCommands.ts); keep the two in step. Departures
 * from the donor: ⌘O is Go to Symbol and ⌘T Type Hierarchy (Open Project is
 * menu-only, New Tab moved to ⌘N), and ⌘S is Save All.
 */

export const APP_NAME = 'TempCode'

export interface MenuCommand {
  id: string
  label: string
  accelerator?: string
  /** A toggle: the native item shows a check the renderer keeps in step. */
  checkbox?: boolean
}

export type MenuNode =
  | { kind: 'separator' }
  | { kind: 'role'; role: string }
  | ({ kind: 'command' } & MenuCommand)

export interface MenuSection {
  label: string
  role?: 'windowMenu'
  items: MenuNode[]
}

const sep: MenuNode = { kind: 'separator' }
const role = (name: string): MenuNode => ({ kind: 'role', role: name })
const cmd = (id: string, label: string, accelerator?: string, options: { checkbox?: boolean } = {}): MenuNode => ({
  kind: 'command',
  id,
  label,
  ...(accelerator ? { accelerator } : {}),
  ...(options.checkbox ? { checkbox: true } : {})
})

export const MENU_TREE: MenuSection[] = [
  {
    label: APP_NAME,
    items: [
      role('about'),
      sep,
      cmd('open_settings', 'Settings…', 'CmdOrCtrl+,'),
      cmd('check_for_updates', 'Check for Updates…'),
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
      cmd('new_window', 'New Window', 'CmdOrCtrl+Shift+N'),
      cmd('open_project', 'Open Project…'),
      cmd('open_search', 'Search…', 'CmdOrCtrl+K'),
      cmd('go_to_file', 'Go to File…', 'CmdOrCtrl+P'),
      cmd('go_to_symbol', 'Go to Symbol…', 'CmdOrCtrl+O'),
      cmd('show_hierarchy', 'Type Hierarchy', 'CmdOrCtrl+T'),
      cmd('find_in_project', 'Find in Files…', 'CmdOrCtrl+Shift+F'),
      sep,
      cmd('save_all', 'Save All', 'CmdOrCtrl+S'),
      sep,
      cmd('new_tab', 'New Tab', 'CmdOrCtrl+N'),
      cmd('new_terminal', 'New Terminal', 'CmdOrCtrl+`'),
      cmd('new_terminal_tab', 'New Terminal Tab', 'CmdOrCtrl+Shift+`'),
      cmd('split_right', 'Split Pane Right', 'CmdOrCtrl+D'),
      cmd('split_down', 'Split Pane Down', 'CmdOrCtrl+Shift+D'),
      cmd('close_tab', 'Close Pane', 'CmdOrCtrl+W'),
      sep,
      cmd('prev_tab', 'Previous Tab', 'CmdOrCtrl+Shift+['),
      cmd('next_tab', 'Next Tab', 'CmdOrCtrl+Shift+]'),
      cmd('back_tab', 'Go Back', 'CmdOrCtrl+['),
      cmd('forward_tab', 'Go Forward', 'CmdOrCtrl+]')
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
      cmd('find', 'Find', 'CmdOrCtrl+F')
    ]
  },
  {
    label: 'View',
    items: [
      cmd('toggle_sidebar', 'Toggle Sidebar', 'CmdOrCtrl+B'),
      cmd('toggle_zen', 'Toggle Zen Mode', 'CmdOrCtrl+Alt+Z'),
      cmd('open_inbox', 'Inbox'),
      cmd('mark_all_read', 'Mark All Threads as Read'),
      cmd('open_notes', 'Notes'),
      cmd('next_environment', 'Next Environment', 'CmdOrCtrl+Alt+]'),
      cmd('prev_environment', 'Previous Environment', 'CmdOrCtrl+Alt+['),
      cmd('toggle_group_by_host', 'Group by Host', undefined, { checkbox: true }),
      cmd('toggle_terminal', 'Toggle Terminal', 'CmdOrCtrl+J'),
      cmd('open_model_picker', 'Switch Model…', 'CmdOrCtrl+.'),
      sep,
      cmd('focus_left', 'Focus Pane Left', 'CmdOrCtrl+Alt+Left'),
      cmd('focus_right', 'Focus Pane Right', 'CmdOrCtrl+Alt+Right'),
      cmd('focus_up', 'Focus Pane Up', 'CmdOrCtrl+Alt+Up'),
      cmd('focus_down', 'Focus Pane Down', 'CmdOrCtrl+Alt+Down'),
      sep,
      cmd('sidebar_opacity', 'Sidebar Appearance…'),
      sep,
      cmd('zoom_in', 'Zoom In', 'CmdOrCtrl+='),
      cmd('zoom_out', 'Zoom Out', 'CmdOrCtrl+-'),
      cmd('zoom_reset', 'Actual Size', 'CmdOrCtrl+0')
    ]
  },
  { label: 'Window', role: 'windowMenu', items: [] }
]

/** Every custom item, in menu order. */
export const MENU_COMMANDS: MenuCommand[] = MENU_TREE.flatMap((section) =>
  section.items.filter((item): item is { kind: 'command' } & MenuCommand => item.kind === 'command')
).map(({ id, label, accelerator, checkbox }) => ({ id, label, ...(accelerator ? { accelerator } : {}), ...(checkbox ? { checkbox } : {}) }))

/** Quit acts in main; the other 38 go to the focused renderer (New Window
 *  falls back to main only when no window is there to take it). */
export const MAIN_MENU_IDS = ['quit'] as const

export const RENDERER_MENU_IDS: string[] = MENU_COMMANDS.map((c) => c.id).filter(
  (id) => !(MAIN_MENU_IDS as readonly string[]).includes(id)
)
