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

  it('stay within the tools/list budget the bridge pays on every Mac thread', () => {
    for (const shape of WORDS_SHAPES) {
      const list = computerToolSpecs(shape, 'act').map((t) => ({ name: t.name, description: t.description, inputSchema: computerToolJsonSchema(t.input) }))
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
