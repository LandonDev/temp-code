import { describe, expect, it } from 'vitest'
import { APP_NAME, MAIN_MENU_IDS, MENU_COMMANDS, MENU_TREE, RENDERER_MENU_IDS } from './menu-tree'

/** The donor's table, section 3 of the bridge notes, plus M8e's Go to
 *  Symbol / Type Hierarchy / Save All (Open Project lost ⌘O, New Tab ⌘T). */
const EXPECTED: [string, string | undefined][] = [
  ['open_settings', 'CmdOrCtrl+,'],
  ['check_for_updates', undefined],
  ['quit', 'CmdOrCtrl+Q'],
  ['new_window', 'CmdOrCtrl+Shift+N'],
  ['open_project', undefined],
  ['open_search', 'CmdOrCtrl+K'],
  ['go_to_file', 'CmdOrCtrl+P'],
  ['go_to_symbol', 'CmdOrCtrl+O'],
  ['show_hierarchy', 'CmdOrCtrl+T'],
  ['find_in_project', 'CmdOrCtrl+Shift+F'],
  ['save_all', 'CmdOrCtrl+S'],
  ['new_tab', 'CmdOrCtrl+N'],
  ['new_terminal', 'CmdOrCtrl+`'],
  ['new_terminal_tab', 'CmdOrCtrl+Shift+`'],
  ['split_right', 'CmdOrCtrl+D'],
  ['split_down', 'CmdOrCtrl+Shift+D'],
  ['close_tab', 'CmdOrCtrl+W'],
  ['prev_tab', 'CmdOrCtrl+Shift+['],
  ['next_tab', 'CmdOrCtrl+Shift+]'],
  ['back_tab', 'CmdOrCtrl+['],
  ['forward_tab', 'CmdOrCtrl+]'],
  ['find', 'CmdOrCtrl+F'],
  ['toggle_sidebar', 'CmdOrCtrl+B'],
  ['toggle_zen', 'CmdOrCtrl+Alt+Z'],
  ['open_inbox', undefined],
  ['open_notes', undefined],
  ['toggle_terminal', 'CmdOrCtrl+J'],
  ['open_model_picker', 'CmdOrCtrl+.'],
  ['focus_left', 'CmdOrCtrl+Alt+Left'],
  ['focus_right', 'CmdOrCtrl+Alt+Right'],
  ['focus_up', 'CmdOrCtrl+Alt+Up'],
  ['focus_down', 'CmdOrCtrl+Alt+Down'],
  ['sidebar_opacity', undefined],
  ['zoom_in', 'CmdOrCtrl+='],
  ['zoom_out', 'CmdOrCtrl+-'],
  ['zoom_reset', 'CmdOrCtrl+0']
]

describe('menu tree', () => {
  it('carries every id with the accelerator the donor used', () => {
    const actual = MENU_COMMANDS.map((c) => [c.id, c.accelerator])
    expect(actual).toEqual(EXPECTED)
  })

  it('sends 34 ids to the renderer and keeps two in main', () => {
    expect(MAIN_MENU_IDS).toEqual(['new_window', 'quit'])
    expect(RENDERER_MENU_IDS).toHaveLength(34)
    expect(RENDERER_MENU_IDS).not.toContain('quit')
  })

  it('has no duplicate ids', () => {
    const ids = MENU_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orders the sections the way the donor did and names us', () => {
    expect(MENU_TREE.map((s) => s.label)).toEqual([APP_NAME, 'File', 'Edit', 'View', 'Window'])
    expect(APP_NAME).toBe('TempCode')
    expect(MENU_TREE[0].items.some((i) => i.kind === 'command' && i.label === 'Quit TempCode')).toBe(
      true
    )
  })
})
