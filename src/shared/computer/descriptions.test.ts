import { describe, expect, it } from 'vitest'
import {
  COMPUTER_SEARCH_HINT,
  FIELD_DESCRIPTION_MAX,
  PER_VERB_DESCRIPTION_MAX,
  SEARCH_HINT_MAX,
  TOOL_DESCRIPTION_MAX,
  TOOLS_LIST_MAX,
  TOOL_SHAPES,
  WORDS_SHAPES,
  fieldWords,
  perVerbDescription,
  toolDescription
} from './descriptions'
import { CONFIRM_KINDS } from './policy'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS } from './protocol'
import { COMPUTER_BRIDGE_NOTE, COMPUTER_TOOL_NAMES, ComputerActInputSchema, ComputerBatchInputSchema, computerToolJsonSchema, computerToolSpecs, perVerbTools } from './tools'

type Json = Record<string, unknown>

/** Every property anywhere in a schema, with its path. */
function properties(schema: Json, path = ''): { path: string; schema: Json }[] {
  const out: { path: string; schema: Json }[] = []
  for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    out.push({ path: `${path}${k}`, schema: v }, ...properties(v, `${path}${k}.`))
  }
  if (schema.items) out.push(...properties(schema.items as Json, `${path}[].`))
  return out
}

describe('the tool descriptions', () => {
  it('give every tool words in both shapes, within the budget', () => {
    for (const shape of WORDS_SHAPES)
      for (const tools of TOOL_SHAPES) {
        for (const name of COMPUTER_TOOL_NAMES) {
          const d = toolDescription(shape, tools, name)
          expect(d.length, `${shape}/${tools} ${name}`).toBeGreaterThan(200)
          expect(d.length, `${shape}/${tools} ${name}`).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX)
          expect(d).not.toMatch(/\{\w+\}/)
        }
      }
  })

  it('differ between the shapes', () => {
    for (const name of COMPUTER_TOOL_NAMES) expect(toolDescription('anthropic', 'act', name)).not.toBe(toolDescription('cua', 'act', name))
    expect(toolDescription('cua', 'act', 'computer_observe')).toContain('getAXState')
    expect(toolDescription('cua', 'act', 'computer_act')).toContain('performSecondaryAction')
  })

  it('name every action in computer_act and computer_batch', () => {
    for (const shape of WORDS_SHAPES)
      for (const action of COMPUTER_ACTION_NAMES) {
        expect(toolDescription(shape, 'act', 'computer_act'), `${shape} act ${action}`).toMatch(new RegExp(`\\b${action}\\b`))
        expect(toolDescription(shape, 'act', 'computer_batch'), `${shape} batch ${action}`).toMatch(new RegExp(`\\b${action}\\b`))
      }
  })

  it('point the batch at the per-verb tools in that shape', () => {
    expect(toolDescription('anthropic', 'act', 'computer_batch')).toContain("Each step takes computer_act's fields")
    expect(toolDescription('anthropic', 'per-verb', 'computer_batch')).toContain('Each step takes the fields of its own computer_<action> tool')
    expect(toolDescription('anthropic', 'per-verb', 'computer_batch')).not.toContain('computer_act')
  })

  it('keep the search hint short', () => {
    expect(COMPUTER_SEARCH_HINT.length).toBeLessThanOrEqual(SEARCH_HINT_MAX)
  })
})

describe('the tool specs', () => {
  it('list the four tools, or the per-verb set in computer_act’s place', () => {
    for (const shape of WORDS_SHAPES) {
      expect(computerToolSpecs(shape, 'act').map((t) => t.name)).toEqual(['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'])
      const perVerb = computerToolSpecs(shape, 'per-verb').map((t) => t.name)
      expect(perVerb.slice(0, 3)).toEqual(['computer_apps', 'computer_observe', 'computer_batch'])
      expect(perVerb.slice(3)).toEqual(COMPUTER_ACTION_NAMES.map((a) => `computer_${a}`))
    }
    expect(computerToolSpecs('cua', 'act')).toBe(computerToolSpecs('cua', 'act'))
  })

  it('describe every field of every tool, nested ones included, within 200 characters; a batch step only its action', () => {
    for (const shape of WORDS_SHAPES)
      for (const tools of TOOL_SHAPES)
        for (const spec of computerToolSpecs(shape, tools)) {
          const props = properties(computerToolJsonSchema(spec.input))
          expect(props.length).toBeGreaterThanOrEqual(spec.name === 'computer_apps' ? 1 : 3)
          for (const p of props) {
            const d = p.schema.description
            // §27.12: a batch step's fields are computer_act's, described there once
            if (p.path.startsWith('actions.[].') && p.path !== 'actions.[].action') {
              expect(d, `${shape}/${tools} ${spec.name} ${p.path}`).toBeUndefined()
              continue
            }
            expect(typeof d, `${shape}/${tools} ${spec.name} ${p.path}`).toBe('string')
            expect((d as string).length, `${shape} ${spec.name} ${p.path}`).toBeLessThanOrEqual(FIELD_DESCRIPTION_MAX)
          }
        }
  })

  it('carry the cua glosses in the cua fields', () => {
    const act = computerToolJsonSchema(computerToolSpecs('cua', 'act')[2].input) as { properties: Record<string, Json> }
    expect(act.properties.value.description).toContain('setValue')
    expect(act.properties.name.description).toContain('performSecondaryAction')
  })

  it('give confirm the policy’s kinds, on act, batch and every per-verb tool that sends input', () => {
    for (const shape of WORDS_SHAPES) {
      const [, , act, batch] = computerToolSpecs(shape, 'act').map((t) => computerToolJsonSchema(t.input) as { properties: Record<string, Json> })
      for (const s of [act, batch]) {
        const confirm = s.properties.confirm as { properties: Record<string, Json>; required: string[] }
        expect(confirm.properties.kind.enum).toEqual([...CONFIRM_KINDS])
        expect(confirm.required).toEqual(['kind', 'what'])
      }
      for (const spec of perVerbTools(shape)) {
        const action = spec.name.slice('computer_'.length) as (typeof COMPUTER_ACTION_NAMES)[number]
        const props = (computerToolJsonSchema(spec.input) as { properties: Json }).properties as Json
        expect('confirm' in props, spec.name).toBe(!NO_INPUT_ACTIONS.includes(action))
      }
    }
  })

  it('add computer_result last only when asked, in both tool shapes, every name unique', () => {
    for (const shape of WORDS_SHAPES)
      for (const tools of TOOL_SHAPES) {
        const four = computerToolSpecs(shape, tools).map((t) => t.name)
        const bridge = computerToolSpecs(shape, tools, { result: true }).map((t) => t.name)
        expect(four, `${shape}/${tools}`).not.toContain('computer_result')
        expect(bridge, `${shape}/${tools}`).toEqual([...four, 'computer_result'])
        expect(new Set(bridge).size, `${shape}/${tools}`).toBe(bridge.length)
      }
    expect(computerToolSpecs('cua', 'act', { result: true })).toBe(computerToolSpecs('cua', 'act', { result: true }))
    expect(computerToolSpecs('cua', 'act', { result: false })).toBe(computerToolSpecs('cua', 'act'))
  })

  it('word computer_result in one sentence a shape, its fields within the cap', () => {
    expect(toolDescription('anthropic', 'act', 'computer_result')).toBe(
      'Gets the result of a computer call that answered "Held", by its id, waiting up to 20 s, or says it is still held. cancel: true cancels it; a held call never runs unless you ask for its result.'
    )
    for (const shape of WORDS_SHAPES) {
      const d = toolDescription(shape, 'act', 'computer_result')
      for (const fact of ['"Held"', 'its id', '20 s', 'still held', 'cancel: true', 'never runs unless you ask for its result']) expect(d, `${shape} ${fact}`).toContain(fact)
      const spec = computerToolSpecs(shape, 'act', { result: true }).at(-1)!
      const schema = computerToolJsonSchema(spec.input) as { properties: Record<string, Json>; required: string[] }
      expect(Object.keys(schema.properties)).toEqual(['id', 'cancel'])
      expect(schema.required).toEqual(['id'])
      for (const p of Object.values(schema.properties)) expect((p.description as string).length).toBeLessThanOrEqual(FIELD_DESCRIPTION_MAX)
    }
    expect(toolDescription('cua', 'act', 'computer_result')).not.toBe(toolDescription('anthropic', 'act', 'computer_result'))
  })

  it('stay within the tools/list budget the bridge pays on every Mac thread, computer_result included, local and remote', () => {
    for (const shape of WORDS_SHAPES) {
      const list = computerToolSpecs(shape, 'act', { result: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: computerToolJsonSchema(t.input) }))
      expect(list).toHaveLength(5)
      expect(JSON.stringify(list).length, shape).toBeLessThanOrEqual(TOOLS_LIST_MAX)
      // a box thread's listing: the remote-Mac note rides on computer_apps alone (mcp.ts, §27.12)
      const remote = list.map((t) => (t.name === 'computer_apps' ? { ...t, description: t.description + COMPUTER_BRIDGE_NOTE } : t))
      expect(JSON.stringify(remote).length, `${shape} remote`).toBeLessThanOrEqual(TOOLS_LIST_MAX)
      for (const t of list) {
        expect(t.inputSchema.oneOf).toBeUndefined()
        expect(t.inputSchema.anyOf).toBeUndefined()
      }
    }
  })

  it('keep each per-verb description within 400 characters, with the shared tail', () => {
    for (const shape of WORDS_SHAPES)
      for (const spec of perVerbTools(shape)) {
        expect(spec.description.length, spec.name).toBeLessThanOrEqual(PER_VERB_DESCRIPTION_MAX)
        expect(spec.description).toContain('your next read')
      }
    expect(perVerbTools('cua').find((t) => t.name === 'computer_set_value')!.description).toContain('setValue')
  })
})

describe('the confirm flag on the inputs', () => {
  it('rides act and batch, and is checked', () => {
    const confirm = { kind: 'send', what: 'Reply to Ana' }
    expect(ComputerActInputSchema.parse({ app: 'Mail', action: 'left_click', element: 4, confirm }).confirm).toEqual(confirm)
    expect(ComputerBatchInputSchema.parse({ app: 'Mail', actions: [{ action: 'key', text: 'Return' }], confirm }).confirm).toEqual(confirm)
    expect(ComputerActInputSchema.safeParse({ app: 'Mail', action: 'left_click', element: 4, confirm: { kind: 'password', what: 'x' } }).success).toBe(false)
  })

  it('a per-verb call checks the same rules', () => {
    const click = perVerbTools().find((t) => t.name === 'computer_left_click')!
    expect(click.input.safeParse({ app: 'Mail', element: 4, confirm: { kind: 'delete', what: 'Delete the draft' } }).success).toBe(true)
    expect(click.input.safeParse({ app: 'Mail', element: 4, coordinate: [1, 1] }).success).toBe(false)
  })
})

describe('the window actions (§22)', () => {
  it('tell the model the title-bar buttons are elements and what minimized means, in both shapes', () => {
    for (const shape of WORDS_SHAPES) {
      const observe = toolDescription(shape, 'act', 'computer_observe')
      expect(observe).toContain('Title-bar buttons are elements')
      expect(observe).toContain('a whole read with no close line means the window cannot close')
      expect(observe).toContain('"minimized" on the window line')
      expect(observe.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX)
    }
  })

  it('name raise among perform\'s role defaults, out of the Dock too, within the caps', () => {
    for (const shape of WORDS_SHAPES) {
      const perform = perVerbDescription(shape, 'perform')
      expect(perform).toContain('raise on a window, out of the Dock too, when the Mac is free')
      expect(perform.length).toBeLessThanOrEqual(PER_VERB_DESCRIPTION_MAX)
      const name = fieldWords(shape).name
      expect(name).toContain('raise (a window, from the Dock too)')
      expect(name.length).toBeLessThanOrEqual(FIELD_DESCRIPTION_MAX)
    }
  })
})

describe('the background routes in the words (§24)', () => {
  it('computer_act says what a step does in the background, in both shapes, within the caps', () => {
    const act = toolDescription('anthropic', 'act', 'computer_act')
    expect(act).toContain('In the background a shortcut runs its menu item, a click presses the element under it and text goes straight into the field')
    expect(act).toContain('a disabled menu item waits for the Mac to be free')
    const cua = toolDescription('cua', 'act', 'computer_act')
    expect(cua).toContain("In the background pressKey runs the combo's menu item, click presses the element under it")
    for (const shape of WORDS_SHAPES) for (const name of ['computer_act', 'computer_batch'] as const) expect(toolDescription(shape, 'act', name).length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX)
  })

  it('the key and scroll tools say their background way', () => {
    for (const shape of WORDS_SHAPES) {
      expect(perVerbDescription(shape, 'key')).toContain("In the background it runs the app's menu item for the combo.")
      expect(perVerbDescription(shape, 'scroll')).toContain('In the background it moves the scroll bar.')
      for (const verb of ['key', 'scroll'] as const) expect(perVerbDescription(shape, verb).length).toBeLessThanOrEqual(PER_VERB_DESCRIPTION_MAX)
    }
  })
})

describe("computer_apps' open", () => {
  it('says in both shapes that launch and open stay in the background, never programs, and to prefer a file you made', () => {
    for (const shape of WORDS_SHAPES) {
      const text = toolDescription(shape, 'act', 'computer_apps')
      expect(text, shape).toContain('open')
      expect(text, shape).toContain('never programs')
      expect(text, shape).toContain('the result says so')
      expect(text, shape).toContain('prefer')
      expect(text, shape).toContain('File › New')
      const fields = fieldWords(shape)
      expect(fields.open, shape).toContain('Never programs')
      expect(fields['apps.confirm'], shape).toContain('confirm')
    }
  })
})

describe('web content words (§25)', () => {
  for (const shape of WORDS_SHAPES) {
    it(`${shape}: teaches tabs, covered pages, long reads, picks and focused keys within the budgets`, () => {
      const observe = toolDescription(shape, 'act', 'computer_observe')
      expect(observe).toContain('In a browser, window may name a tab: a background tab is selected first and the result says so.')
      expect(observe).toContain('"page not drawn" means the window is covered and the browser has not drawn that tab: perform raise on its window draws it when the Mac is free.')
      expect(observe).toContain('"… N more below" under a list or table in a page: observe with element set to its [index] reads its rows, up to a few thousand; past that the read says it was cut, and you read on from a later row.')
      const act = toolDescription(shape, 'act', 'computer_act')
      expect(act).toContain('on a pop up picks the item of that name, and a value that did not take fails the step.')
      expect(act).toContain('takes element to focus first; in a browser, text and keys with no element never go into its address bar.')
      expect(fieldWords(shape).window).toBe("Part of the window's title, or a tab's title in a browser (that tab is selected first). Left out: the window you used last in this app, else its main window.")
      expect(fieldWords(shape).element).toContain('key and hold_key: the element to focus first.')
      for (const verb of ['key', 'hold_key'] as const) expect(perVerbDescription(shape, verb)).toContain('element focuses it first.')
      expect(perVerbDescription(shape, 'set_value')).toContain('On a pop up it picks the item by name.')
      expect(toolDescription(shape, 'act', 'computer_apps')).toContain("each browser window's tabs")
    })
  }
})

describe('fewer calls in the words (§27)', () => {
  for (const shape of WORDS_SHAPES) {
    it(`${shape}: says each fact once where it belongs, and drops the sentences it replaces`, () => {
      const act = toolDescription(shape, 'act', 'computer_act')
      expect(act).toContain('A step that opens a menu or a window returns it: pick from it in the same batch with named.')
      expect(act).toContain('Name a target by element, by named: "Team" (its name in the tree), or a menu-bar item by menu: "File > Save…", which needs no read of the menu bar.')
      const batch = toolDescription(shape, 'act', 'computer_batch')
      for (const fact of [
        "Each step takes computer_act's fields, with action one of left_click,",
        'A step can target what an earlier step opens, by named.',
        'After a step that names a field or opens one, type and key go to it; otherwise the batch stops there and says where the focus is.',
        'Keys after a step that changed nothing do not run.'
      ])
        expect(batch, fact).toContain(fact)
      for (const gone of ['An element the batch makes appear needs the next read.', 'After another action in the same batch, type and paste name their element.', 'press Tab, type'])
        expect(batch, gone).not.toContain(gone)
      const observe = toolDescription(shape, 'act', 'computer_observe')
      expect(observe).toContain("An act's result is your next read; read again only when it says something is missing.")
      expect(observe).toContain('menus: true lists each menu on one line; to run an item you know, use menu.')
      expect(observe).not.toMatch(/read (again|twice) with no action between/)
      const fields = fieldWords(shape)
      expect(fields.named).toBe('An element by its name in the tree, for one this call opens or one you have not read. Instead of element or coordinate.')
      expect(fields.menu).toBe('A menu-bar item by its path, File > Save…; picks it with no menu open. left_click, or perform with name pick.')
    })
  }

  it('describe named and menu on computer_act and the per-verb tools that take them, never on a batch step', () => {
    for (const shape of WORDS_SHAPES) {
      const [, , act, batch] = computerToolSpecs(shape, 'act').map((t) => computerToolJsonSchema(t.input) as { properties: Record<string, Json> })
      expect(act.properties.named.description).toBe(fieldWords(shape).named)
      expect(act.properties.menu.description).toBe(fieldWords(shape).menu)
      const step = (batch.properties.actions as { items: { properties: Record<string, Json> } }).items.properties
      expect(step.named.description).toBeUndefined()
      expect(step.action.description).toBe(fieldWords(shape).action)
      const pick = perVerbTools(shape).find((t) => t.name === 'computer_perform')!
      expect((computerToolJsonSchema(pick.input) as { properties: Record<string, Json> }).properties.menu.description).toBe(fieldWords(shape).menu)
    }
  })
})
