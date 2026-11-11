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
import { COMPUTER_TOOL_NAMES, ComputerActInputSchema, ComputerBatchInputSchema, computerToolJsonSchema, computerToolSpecs, perVerbTools } from './tools'

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
    expect(toolDescription('anthropic', 'act', 'computer_batch')).toContain('as computer_act takes them')
    expect(toolDescription('anthropic', 'per-verb', 'computer_batch')).toContain('computer_<action> tool')
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

  it('describe every field of every tool, nested ones included, within 200 characters', () => {
    for (const shape of WORDS_SHAPES)
      for (const tools of TOOL_SHAPES)
        for (const spec of computerToolSpecs(shape, tools)) {
          const props = properties(computerToolJsonSchema(spec.input))
          expect(props.length).toBeGreaterThanOrEqual(spec.name === 'computer_apps' ? 1 : 3)
          for (const p of props) {
            const d = p.schema.description
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

  it('stay within the tools/list budget the bridge pays on every Mac thread, computer_result included', () => {
    for (const shape of WORDS_SHAPES) {
      const list = computerToolSpecs(shape, 'act', { result: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: computerToolJsonSchema(t.input) }))
      expect(list).toHaveLength(5)
      expect(JSON.stringify(list).length, shape).toBeLessThanOrEqual(TOOLS_LIST_MAX)
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
    expect(act).toContain('In the background a shortcut runs its menu item, a click presses the element under it and text goes straight in')
    const cua = toolDescription('cua', 'act', 'computer_act')
    expect(cua).toContain("In the background pressKey runs the combo's menu item, click presses the element under it")
    // a command that needs the app active brings it forward, save_as checks the disk, and the uncommitted words (§25)
    for (const text of [act, cua]) {
      expect(text).toContain('a command that needs the app in front (Save, Move to Trash) brings it forward a moment')
      expect(text).toContain('save_as saves to a path and checks the file; "on screen only" means the disk did not change.')
    }
    for (const shape of WORDS_SHAPES) {
      expect(perVerbDescription(shape, 'save_as')).toContain('checks the file on disk')
      expect(fieldWords(shape).path).toContain('file name')
    }
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
