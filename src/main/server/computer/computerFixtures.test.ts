import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatObservation, parseObservation } from '../../../shared/computer/observation'
import {
  COMPUTER_ERROR_KINDS,
  COMPUTER_METHODS,
  ComputerNotificationSchema,
  FixtureMetaSchema,
  HostNotificationSchema,
  NotificationFrameSchema,
  RawAXTreeSchema,
  RpcErrorResponseSchema,
  SHOT,
  STEP_ONLY_ERROR_KINDS,
  requestFrameSchema,
  resultFrameSchema,
  type ComputerMethod
} from '../../../shared/computer/protocol'

// The computer-use fixtures (fixtures/README.md) held to their schemas, to
// the observation grammar, and to the privacy guard: the repository is public.

const root = join(__dirname, 'fixtures')
const wire = join(root, 'wire')
const read = (path: string): string => readFileSync(path, 'utf8')
const json = (path: string): unknown => JSON.parse(read(path))

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** A second request of one method: `input.restoreSession` right after the person's touch stopped a step. */
const VARIANTS: Readonly<Record<string, ComputerMethod>> = {
  'input.restoreSession.after-interrupt.request.json': 'input.restoreSession',
  // a host that speaks the front tier, save_as and the commit check (§25); the plain files are an older peer's
  'initialize.features.request.json': 'initialize',
  'action.run.front.request.json': 'action.run',
  'action.run.save_as.request.json': 'action.run'
}
const RESULT_VARIANTS: Readonly<Record<string, ComputerMethod>> = {
  'initialize.features.response.json': 'initialize',
  'action.run.front.response.json': 'action.run'
}
/** A second response of one method: the restore that ended a person guard (§14.9). */
const RESPONSE_VARIANTS: Readonly<Record<string, ComputerMethod>> = { 'input.restoreSession.guarded.response.json': 'input.restoreSession' }
const notificationFile = (method: string): string => `notify-${method.replace(/^\$\//, '').replace(/\//g, '-')}.json`
const serviceNotes = ComputerNotificationSchema.options.map((o) => o.shape.method.value)
const hostNotes = HostNotificationSchema.options.map((o) => o.shape.method.value)

describe('wire fixtures', () => {
  const files = new Set(readdirSync(wire))

  it('have a request and a response for every method, each parsing with its schema', () => {
    for (const method of Object.keys(COMPUTER_METHODS) as ComputerMethod[]) {
      const request = requestFrameSchema(method).safeParse(json(join(wire, `${method}.request.json`)))
      expect(request.error?.issues, `${method}.request`).toBeUndefined()
      const response = resultFrameSchema(method).safeParse(json(join(wire, `${method}.response.json`)))
      expect(response.error?.issues, `${method}.response`).toBeUndefined()
      expect((json(join(wire, `${method}.request.json`)) as { id: number }).id).toBe((json(join(wire, `${method}.response.json`)) as { id: number }).id)
    }
  })

  it('have one per error kind, where that kind rides', () => {
    for (const kind of COMPUTER_ERROR_KINDS) {
      const frame = json(join(wire, `error-${kind}.json`))
      if (STEP_ONLY_ERROR_KINDS.includes(kind)) {
        const parsed = resultFrameSchema('action.run').parse(frame)
        expect(parsed.result.step.status, kind).toBe('failed')
        if (parsed.result.step.status === 'failed') expect(parsed.result.step.error.kind).toBe(kind)
      } else {
        const parsed = RpcErrorResponseSchema.parse(frame)
        expect(parsed.error.code, kind).toBe(-32000)
        expect(parsed.error.data?.kind, kind).toBe(kind)
      }
    }
  })

  it('have one per notification of either side', () => {
    for (const method of [...serviceNotes, ...hostNotes]) {
      const frame = json(join(wire, notificationFile(method)))
      expect(NotificationFrameSchema.safeParse(frame).success, method).toBe(true)
      const schema = hostNotes.includes(method as (typeof hostNotes)[number]) ? HostNotificationSchema : ComputerNotificationSchema
      expect(schema.safeParse(frame).error?.issues, method).toBeUndefined()
    }
  })

  it('take the requests a method has in more than one shape', () => {
    for (const [file, method] of Object.entries(VARIANTS)) {
      const request = requestFrameSchema(method).safeParse(json(join(wire, file)))
      expect(request.error?.issues, file).toBeUndefined()
    }
    for (const [file, method] of Object.entries(RESULT_VARIANTS)) {
      const response = resultFrameSchema(method).safeParse(json(join(wire, file)))
      expect(response.error?.issues, file).toBeUndefined()
    }
  })

  it('keep the front tier, save_as and features out of what an older peer sends (§25, decision 14)', () => {
    expect(json(join(wire, 'initialize.request.json'))).not.toHaveProperty('params.features')
    expect(json(join(wire, 'initialize.response.json'))).not.toHaveProperty('result.features')
    expect(resultFrameSchema('initialize').parse(json(join(wire, 'initialize.features.response.json'))).result.features).toEqual(['front', 'commit', 'save_as'])
    const step = resultFrameSchema('action.run').parse(json(join(wire, 'action.run.front.response.json'))).result.step
    expect(step.status === 'ok' && step.tier).toBe('front')
    expect(step.status === 'ok' && step.disk?.saved).toBe('~/run/Total.txt')
  })

  it('take the responses a method has in more than one shape', () => {
    for (const [file, method] of Object.entries(RESPONSE_VARIANTS)) {
      const response = resultFrameSchema(method).safeParse(json(join(wire, file)))
      expect(response.error?.issues, file).toBeUndefined()
    }
    const guarded = resultFrameSchema('input.restoreSession').parse(json(join(wire, 'input.restoreSession.guarded.response.json')))
    expect(guarded.result.personGuard?.mode).toBe('active')
    expect(resultFrameSchema('input.restoreSession').parse(json(join(wire, 'input.restoreSession.response.json'))).result.personGuard).toBeUndefined()
  })

  it('hold nothing else', () => {
    const expected = new Set([
      ...Object.keys(COMPUTER_METHODS).flatMap((m) => [`${m}.request.json`, `${m}.response.json`]),
      ...Object.keys(VARIANTS),
      ...Object.keys(RESULT_VARIANTS),
      ...Object.keys(RESPONSE_VARIANTS),
      ...COMPUTER_ERROR_KINDS.map((k) => `error-${k}.json`),
      ...[...serviceNotes, ...hostNotes].map(notificationFile)
    ])
    expect([...files].sort()).toEqual([...expected].sort())
  })

  it('carry observation texts that keep to the grammar', () => {
    for (const file of files) {
      const text = read(join(wire, file))
      for (const m of text.matchAll(/"text": ("(?:[^"\\]|\\.)*")/g)) {
        const value = JSON.parse(m[1]) as string
        if (value.startsWith('app "')) expect(formatObservation(parseObservation(value)), file).toBe(value)
      }
    }
  })
})

describe('observation fixtures', () => {
  const cases = ['full', 'diff', 'unchanged', 'truncated', 'thin', 'stub', 'loading', 'geometry', 'menus', 'escapes']
  const texts = [
    ...cases.map((c) => join(root, 'observations', `${c}.txt`)),
    // the AX reader's goldens: a full read, the diff from the state before, the budget's cut
    ...walk(join(root, 'apps')).filter((p) => /\/(observation|diff|truncated)\.txt$/.test(p))
  ]

  it('cover every grammar case', () => {
    expect(readdirSync(join(root, 'observations')).sort()).toEqual(cases.map((c) => `${c}.txt`).sort())
  })

  it('parse, and format back to the same text', () => {
    for (const path of texts) {
      const text = read(path).replace(/\n$/, '')
      expect(formatObservation(parseObservation(text)), relative(root, path)).toBe(text)
    }
  })

  it('format every element line back to itself', () => {
    for (const path of texts) {
      const parsed = parseObservation(read(path).replace(/\n$/, ''))
      const lines = read(path).replace(/\n$/, '').split('\n').slice(1 + (parsed.header.document ? 1 : 0) + (parsed.others.length ? 1 : 0))
      parsed.lines.forEach((line, i) => {
        if (line.type === 'element') expect(formatObservation({ ...parsed, lines: [line] }).split('\n').pop(), `${relative(root, path)}:${i}`).toBe(lines[i])
      })
    }
  })
})

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG')
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error(`no marker at ${i}`)
    const marker = bytes[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + bytes.readUInt16BE(i + 2)
  }
  throw new Error('no frame header')
}

describe('recorded app fixtures', () => {
  const states = [
    'textedit/doc',
    'textedit/doc-shared',
    'textedit/doc-edited',
    'textedit/typed',
    'textedit/save-sheet',
    'chrome/form',
    'chrome/menu-open',
    'chrome/loading',
    'tempcode-dev/first-run',
    'tempcode-dev/thread',
    'intellij/project',
    'finder/folder'
  ]

  it('hold every state', () => {
    for (const state of states) for (const file of ['tree.json', 'meta.json', 'window.jpg']) expect(existsSync(join(root, 'apps', state, file)), `${state}/${file}`).toBe(true)
  })

  it('parse as RawAXTree and FixtureMeta, with a screenshot of the size the meta says', () => {
    for (const state of states) {
      const dir = join(root, 'apps', state)
      if (!existsSync(join(dir, 'meta.json'))) continue
      const tree = RawAXTreeSchema.safeParse(json(join(dir, 'tree.json')))
      expect(tree.error?.issues, `${state}/tree.json`).toBeUndefined()
      const meta = FixtureMetaSchema.parse(json(join(dir, 'meta.json')))
      expect(`${meta.app}/${meta.state}`).toBe(state)
      const jpg = readFileSync(join(dir, 'window.jpg'))
      expect(jpegSize(jpg), state).toEqual({ width: meta.shot.width, height: meta.shot.height })
      expect(jpg.length, state).toBe(meta.shot.bytes)
      expect(Math.max(meta.shot.width, meta.shot.height), state).toBeLessThanOrEqual(meta.shot.maxEdge)
      expect(meta.shot.width * meta.shot.height, state).toBeLessThanOrEqual(SHOT.maxPixels)
      expect(meta.appshot, state).toBe(existsSync(join(dir, 'appshot.txt')))
      if (meta.after) expect(existsSync(join(root, 'apps', meta.app, meta.after.state, 'tree.json')), `${state} follows ${meta.after.state}`).toBe(true)
    }
  })

  it('give IntelliJ no appshot: axdump picks a window before it looks at the title', () => {
    expect(existsSync(join(root, 'apps/intellij/project/appshot.txt'))).toBe(false)
  })
})

describe('the privacy guard', () => {
  const textFiles = walk(root).filter((p) => /\.(json|txt|html|md)$/.test(p))
  const deny = process.env.TC_FIXTURE_DENY
    ? read(process.env.TC_FIXTURE_DENY)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : []

  it('finds no home directory but /Users/me', () => {
    for (const path of textFiles) expect(read(path).match(/\/Users\/(?!me\b)[A-Za-z0-9._-]+/g), relative(root, path)).toBeNull()
  })

  it('finds no email address outside example.com', () => {
    for (const path of textFiles) {
      const emails = read(path).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []
      expect(emails.filter((e) => !/@example\.com$/i.test(e)), relative(root, path)).toEqual([])
    }
  })

  it.skipIf(!deny.length)('finds no string from the deny list (TC_FIXTURE_DENY)', () => {
    for (const path of textFiles) {
      const text = read(path).toLowerCase()
      for (const word of deny) expect(text.includes(word.toLowerCase()), `${relative(root, path)} holds a denied string`).toBe(false)
    }
  })
})
