/**
 * The Swift contract: zod → JSON Schema → Swift source.
 *
 *   bun run gen:swift             writes ios/TempCodeContract/Sources/TempCodeContract/Generated/
 *   bun run check:swift-contract  regenerates into a temp dir and diffs; exit 1 on any difference
 *
 * SUBSET is the one list of what the phone speaks: a method with its params
 * (read from src/shared/contract.ts) and its output (src/shared/wireSchemas.ts),
 * a push, or a named type. To cover another method, add a line, run
 * gen:swift and commit the output; check:swift-contract runs with the
 * typecheck, so a stale Generated/ fails the release gate.
 *
 * The emitter maps JSON Schema to Swift a human would write: structs for
 * objects (nested types for anonymous shapes), String-backed enums with an
 * `unknown(String)` case for literal unions, enums with associated values
 * and an `unknown(JSONValue)` case for discriminated unions, `[String: T]`
 * for records, Int for `.int()` and Double for every other number, no Date
 * anywhere. Optional (`.optional()`) is `T?` left out when nil; nullable
 * (`.nullable()`) is `T?` written as `null`; a request field that is both
 * is `Patch<T>?`. Output is deterministic: SUBSET order, schema key order.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { CONTRACT_VERSION } from '../src/shared/capabilities'
import { ClientRequestSchema } from '../src/shared/contract'
import {
  AudienceSchema,
  CapabilitySchema,
  PairBodySchema,
  WebhookEventSchema
} from '../src/shared/contract-remote'
import { ProjectModeSchema, ThreadTypeSchema } from '../src/shared/domain'
import {
  AttachmentSchema,
  LimitWindowSchema,
  PermissionPolicySchema,
  SessionStatusSchema
} from '../src/shared/events'
import * as W from '../src/shared/wireSchemas'

// ── the subset ──────────────────────────────────────────────────────────

type NamedEntry = { kind: 'type'; id: string; schema: z.ZodType }
type UnionEntry = {
  kind: 'union'
  id: string
  schema: z.ZodType
  discriminator: string
  suffix: string
}
type MethodEntry = { kind: 'method'; method: string; output: z.ZodType }
export type SubsetEntry = NamedEntry | UnionEntry | MethodEntry

const type = (id: string, schema: z.ZodType): NamedEntry => ({ kind: 'type', id, schema })
/** A discriminated union: each branch becomes `<PascalCase(value)><suffix>`. */
const union = (
  id: string,
  schema: z.ZodType,
  discriminator: string,
  suffix: string
): UnionEntry => ({
  kind: 'union',
  id,
  schema,
  discriminator,
  suffix
})
const method = (name: string, output: z.ZodType): MethodEntry => ({
  kind: 'method',
  method: name,
  output
})

export const SUBSET: SubsetEntry[] = [
  // literal unions
  type('ProviderId', W.ProviderIdSchema),
  type('Reasoning', W.ReasoningSchema),
  type('AgentType', W.AgentTypeSchema),
  type('ThreadType', ThreadTypeSchema),
  type('ProjectMode', ProjectModeSchema),
  type('SessionStatus', SessionStatusSchema),
  type('PermissionPolicy', PermissionPolicySchema),
  type('Capability', CapabilitySchema),
  type('Audience', AudienceSchema),
  type('WebhookEvent', WebhookEventSchema),
  type('LimitBucket', (LimitWindowSchema as z.ZodUnion<[z.ZodType, z.ZodType]>).options[0]),
  // bodies and rows
  type('OmittedBody', W.OmittedBodySchema),
  type('Body', W.BodySchema),
  type('Attachment', AttachmentSchema),
  type('ToolPreview', W.WireToolPreviewSchema),
  type('LimitModel', (LimitWindowSchema as z.ZodUnion<[z.ZodType, z.ZodType]>).options[1]),
  type('LimitWindow', LimitWindowSchema),
  union('AgentEvent', W.WireAgentEventSchema, 'type', 'Event'),
  type('EventRow', W.EventRowSchema),
  type('EventsPage', W.EventsPageSchema),
  // sessions, projects, workspaces, the catalog
  type('SessionMeta', W.SessionMetaSchema),
  type('SessionPage', W.SessionPageSchema),
  type('WorkspaceMeta', W.WorkspaceMetaSchema),
  type('ProjectMeta', W.ProjectMetaSchema),
  type('FileChange', W.FileChangeSchema),
  type('QueuedMessage', W.QueuedMessageSchema),
  type('AccountPins', W.AccountPinsSchema),
  type('ModelInfo', W.ModelInfoSchema),
  type('ProviderInfo', W.ProviderInfoSchema),
  // remote access, over the socket and over HTTP
  type('RemoteStatus', W.RemoteStatusSchema),
  type('RemoteKey', W.RemoteKeySchema),
  type('RemotePairing', W.RemotePairingSchema),
  type('RemoteSession', W.RemoteSessionSchema),
  type('CreatedKey', W.CreatedKeySchema),
  type('CreatedPairing', W.CreatedPairingSchema),
  type('HelloResponse', W.HelloResponseSchema),
  type('PairBody', PairBodySchema),
  type('PairKeyResponse', W.PairKeyResponseSchema),
  type('TicketResponse', W.TicketResponseSchema),
  type('HttpError', W.HttpErrorSchema),
  type('FsMedia', W.FsMediaSchema),
  // pushes
  type('LiveEdit', W.LiveEditSchema),
  type('BuildOutput', W.BuildOutputSchema),
  type('BuildRun', W.BuildRunSchema),
  type('BuildUpdate', W.BuildUpdateSchema),
  union('ServerPush', W.RemotePushSchema, 'push', 'Push'),
  // methods: params from contract.ts, outputs from the handlers in server/index.ts
  method('catalog.get', W.CatalogSchema),
  method('workspace.list', z.array(W.WorkspaceMetaSchema)),
  method('project.list', z.array(W.ProjectMetaSchema)),
  method('project.changes', z.array(W.FileChangeSchema)),
  method('project.diff', z.string()),
  method('fs.media', W.FsMediaSchema.nullable()),
  method('session.list', W.SessionPageSchema),
  method('session.events', W.EventsPageSchema),
  method('session.rowBody', z.object({ row: W.EventRowSchema })),
  method('session.subscribe', z.null()),
  method('session.unsubscribe', z.null()),
  method('session.send', z.null()),
  method('session.interrupt', z.null()),
  method('session.approve', z.null()),
  method('session.answer', z.null()),
  method('session.permission', z.null()),
  method('queue.list', z.array(W.QueuedMessageSchema)),
  method('queue.add', z.null()),
  method('queue.remove', z.null()),
  method('queue.update', z.null()),
  method('queue.reorder', z.null()),
  method('queue.steer', z.null()),
  method('remote.status', W.RemoteStatusSchema),
  method('remote.keys.list', z.array(W.RemoteKeySchema)),
  method('remote.keys.create', W.CreatedKeySchema),
  method('remote.keys.revoke', z.boolean()),
  method('remote.pairings.create', W.CreatedPairingSchema),
  method('remote.pairings.list', z.array(W.RemotePairingSchema)),
  method('remote.pairings.revoke', z.boolean()),
  method('remote.sessions.list', z.array(W.RemoteSessionSchema)),
  method('remote.sessions.revoke', z.boolean()),
  method('remote.settings.set', W.RemoteStatusSchema)
]

/** Enum values whose camelCase would not be a Swift identifier. */
const CASE_NAMES: Record<string, string> = { '5h': 'fiveHours' }

// ── zod → JSON Schema ───────────────────────────────────────────────────

interface JS {
  $ref?: string
  type?: string
  properties?: Record<string, JS>
  required?: string[]
  items?: JS
  enum?: string[]
  const?: unknown
  anyOf?: JS[]
  oneOf?: JS[]
  additionalProperties?: JS | boolean
  propertyNames?: JS
}

const PARAMS = '__params:'
const OUTPUT = '__output:'

interface MethodShape {
  method: string
  /** the registry id of the params object, or null for a method without params */
  paramsId: string | null
  /** the registry id of the output schema: a named type's, or this method's own */
  outputId: string
}

/** The schemas the subset names (and the params of its methods), one JSON Schema each. */
export function jsonSchemas(): { defs: Record<string, JS>; methods: MethodShape[] } {
  const registry = z.registry<{ id: string }>()
  // The same schema instance keeps its first id (a named type an output
  // reuses, the `Id` params several remote.* methods share).
  const add = (schema: z.ZodType, id: string): string => {
    if (!registry.has(schema)) registry.add(schema, { id })
    return registry.get(schema)!.id
  }
  const methods: MethodShape[] = []
  for (const entry of SUBSET) {
    if (entry.kind === 'type') add(entry.schema, entry.id)
    else if (entry.kind === 'union') {
      add(entry.schema, entry.id)
      const options = (entry.schema as unknown as z.ZodDiscriminatedUnion<z.ZodObject[]>).options
      for (const branch of options) {
        const literal = (branch.shape[entry.discriminator] as z.ZodLiteral<string>).value
        add(branch, pascal(literal) + entry.suffix)
      }
    } else {
      const request = ClientRequestSchema.options.find((o) => o.shape.method.value === entry.method)
      if (!request) throw new Error(`${entry.method} is not in ClientRequestSchema`)
      const raw = (request.shape as { params?: z.ZodType }).params ?? null
      const params = raw instanceof z.ZodOptional ? (raw.unwrap() as z.ZodType) : raw
      methods.push({
        method: entry.method,
        paramsId: params ? add(params, PARAMS + entry.method) : null,
        outputId: add(entry.output, OUTPUT + entry.method)
      })
    }
  }
  const convert = (io: 'input' | 'output'): Record<string, JS> =>
    z.toJSONSchema(registry, { uri: (id) => `#/$defs/${id}`, io, unrepresentable: 'any' })
      .schemas as Record<string, JS>
  const output = convert('output')
  const input = convert('input')
  const defs: Record<string, JS> = {}
  for (const [id, schema] of Object.entries(output))
    defs[id] = id.startsWith(PARAMS) ? input[id] : schema
  return { defs, methods }
}

// ── naming ──────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while any as await false is nil self super throws true try Any Self Type Protocol some'.split(
    ' '
  )
)
const ident = (name: string): string => (KEYWORDS.has(name) ? `\`${name}\`` : name)

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}
export function pascal(text: string): string {
  return words(text)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}
function camel(text: string): string {
  if (CASE_NAMES[text]) return CASE_NAMES[text]
  const p = pascal(text)
  const out = p[0].toLowerCase() + p.slice(1)
  return /^[0-9]/.test(out) ? `_${out}` : out
}
function singular(name: string): string {
  if (/ies$/.test(name)) return name.slice(0, -3) + 'y'
  if (/(ss|us)$/.test(name)) return name
  if (/(ses|xes|shes|ches)$/.test(name)) return name.slice(0, -2)
  if (/s$/.test(name)) return name.slice(0, -1)
  return name
}
const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1)
const methodTypeName = (name: string): string => pascal(name)

// ── Swift emission ──────────────────────────────────────────────────────

type Lines = string[]
const indent = (lines: Lines, by = 1): Lines => lines.map((l) => (l ? '    '.repeat(by) + l : l))

interface Resolved {
  /** the Swift type expression, without `?` */
  type: string
  /** the schema admits `null` */
  nullable: boolean
  /** the schema is `unknown` (`{}`) */
  unknown: boolean
}

interface Emitter {
  defs: Record<string, JS>
  /** `sorted values` → registered enum name, so inline enums reuse the named type */
  enumNames: Map<string, string>
  /** branch def name → discriminator key, for payload structs */
  branchKeys: Map<string, string>
  /** Inside the `Methods` namespace: top-level names a method type shadows (remote.status vs RemoteStatus). */
  shadowed: Set<string>
}

/** A top-level type name as written where a sibling declaration might shadow it. */
const named = (em: Emitter, name: string): string =>
  em.shadowed.has(name) ? `TempCodeContract.${name}` : name

const enumKey = (values: string[]): string => JSON.stringify([...values].sort())

/** The Swift type for `schema`; anonymous shapes become nested declarations in `sink`, named `hint`. */
function resolve_(
  em: Emitter,
  schema: JS,
  hint: string,
  direction: 'in' | 'out',
  sink: Lines
): Resolved {
  if (schema.$ref) return { type: named(em, refName(schema.$ref)), nullable: false, unknown: false }
  if (schema.anyOf) {
    const branches = schema.anyOf.filter((b) => b.type !== 'null')
    const nullable = branches.length < schema.anyOf.length
    if (branches.length === 1) {
      const inner = resolve_(em, branches[0], hint, direction, sink)
      return { ...inner, nullable: nullable || inner.nullable }
    }
    sink.push(...untaggedUnion(em, hint, branches, direction, sink))
    return { type: hint, nullable, unknown: false }
  }
  if (schema.oneOf) {
    sink.push(...taggedUnion(em, hint, schema.oneOf, discriminatorOf(em, schema.oneOf), direction))
    return { type: hint, nullable: false, unknown: false }
  }
  if (schema.enum) {
    const interned = em.enumNames.get(enumKey(schema.enum))
    if (interned) return { type: named(em, interned), nullable: false, unknown: false }
    sink.push(...stringEnum(hint, schema.enum))
    return { type: hint, nullable: false, unknown: false }
  }
  switch (schema.type) {
    case 'string':
      return { type: 'String', nullable: false, unknown: false }
    case 'number':
      return { type: 'Double', nullable: false, unknown: false }
    case 'integer':
      return { type: 'Int', nullable: false, unknown: false }
    case 'boolean':
      return { type: 'Bool', nullable: false, unknown: false }
    case 'array': {
      const item = resolve_(em, schema.items ?? {}, singular(hint), direction, sink)
      return { type: `[${item.type}${item.nullable ? '?' : ''}]`, nullable: false, unknown: false }
    }
    case 'object': {
      if (schema.properties) {
        sink.push(...struct(em, hint, schema, direction, null))
        return { type: hint, nullable: false, unknown: false }
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const value = resolve_(em, schema.additionalProperties, singular(hint), direction, sink)
        return {
          type: `[String: ${value.type}${value.nullable ? '?' : ''}]`,
          nullable: false,
          unknown: false
        }
      }
      return { type: 'JSONValue', nullable: false, unknown: true }
    }
    case 'null':
      return { type: 'NoOutput', nullable: false, unknown: false }
    default:
      return { type: 'JSONValue', nullable: false, unknown: true }
  }
}

/** The property every branch fixes with a `const`: the union's tag. */
function discriminatorOf(em: Emitter, branches: JS[]): string {
  const candidates = branches.map((b) => {
    const def = b.$ref ? em.defs[refName(b.$ref)] : b
    return new Set(
      Object.entries(def.properties ?? {})
        .filter(([, p]) => p.const !== undefined)
        .map(([k]) => k)
    )
  })
  const shared = [...candidates[0]].filter((k) => candidates.every((c) => c.has(k)))
  if (shared.length !== 1)
    throw new Error(`no single discriminator among ${shared.join(', ') || 'none'}`)
  return shared[0]
}

interface Field {
  key: string
  name: string
  type: string
  /** the key may be absent on the wire */
  optional: boolean
  /** the value may be `null`; written as `null` when required */
  nullable: boolean
}

function fields(
  em: Emitter,
  schema: JS,
  direction: 'in' | 'out',
  skipKey: string | null,
  nested: Lines
): Field[] {
  const required = new Set(schema.required ?? [])
  const out: Field[] = []
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key === skipKey) continue
    const r = resolve_(em, prop, pascal(key), direction, nested)
    const optional = !required.has(key) || r.unknown
    let type = r.type
    if (optional && r.nullable && direction === 'in') type = `Patch<${type}>`
    out.push({
      key,
      name: ident(key),
      type,
      optional,
      nullable: r.nullable && !(optional && direction === 'in')
    })
  }
  return out
}

function struct(
  em: Emitter,
  name: string,
  schema: JS,
  direction: 'in' | 'out',
  skipKey: string | null
): Lines {
  const nested: Lines = []
  const props = fields(em, schema, direction, skipKey, nested)
  const body: Lines = []
  if (nested.length) body.push(...nested, '')
  for (const f of props)
    body.push(`public let ${f.name}: ${f.type}${f.optional || f.nullable ? '?' : ''}`)
  if (props.length) body.push('')
  const params = props.map(
    (f) => `${f.name}: ${f.type}${f.optional || f.nullable ? '?' : ''}${f.optional ? ' = nil' : ''}`
  )
  if (params.length === 0) body.push('public init() {}')
  else {
    body.push(`public init(${params.join(', ')}) {`)
    for (const f of props) body.push(`    self.${f.name} = ${f.name}`)
    body.push('}')
  }
  // A required nullable field must be written as `null`; synthesized encoding would leave it out.
  if (props.some((f) => f.nullable && !f.optional)) {
    body.push(
      '',
      `private enum CodingKeys: String, CodingKey {`,
      `    case ${props.map((f) => f.name).join(', ')}`,
      `}`,
      ''
    )
    body.push(
      'public func encode(to encoder: any Encoder) throws {',
      '    var container = encoder.container(keyedBy: CodingKeys.self)'
    )
    for (const f of props) {
      body.push(
        `    try container.${f.optional ? 'encodeIfPresent' : 'encode'}(${f.name}, forKey: .${f.name})`
      )
    }
    body.push('}')
  }
  return [`public struct ${name}: Codable, Hashable, Sendable {`, ...indent(body), '}']
}

function stringEnum(name: string, values: string[]): Lines {
  const cases = values.map((v) => ({ value: v, name: ident(camel(v)) }))
  return [
    `public enum ${name}: RawRepresentable, Codable, Hashable, Sendable {`,
    ...indent([
      ...cases.map((c) => `case ${c.name}`),
      '/// A value this build does not know; `rawValue` keeps it.',
      'case unknown(String)',
      '',
      'public init(rawValue: String) {',
      '    switch rawValue {',
      ...cases.map((c) => `    case ${JSON.stringify(c.value)}: self = .${c.name}`),
      '    default: self = .unknown(rawValue)',
      '    }',
      '}',
      '',
      'public var rawValue: String {',
      '    switch self {',
      ...cases.map((c) => `    case .${c.name}: ${JSON.stringify(c.value)}`),
      '    case .unknown(let value): value',
      '    }',
      '}'
    ]),
    '}'
  ]
}

function taggedUnion(
  em: Emitter,
  name: string,
  branches: JS[],
  key: string,
  direction: 'in' | 'out'
): Lines {
  const nested: Lines = []
  const cases = branches.map((b, i) => {
    let payload: string
    let def: JS
    if (b.$ref) {
      payload = refName(b.$ref)
      def = em.defs[payload]
    } else {
      payload = `Case${i}`
      def = b
      nested.push(...struct(em, payload, b, direction, key))
    }
    const value = def.properties?.[key]?.const
    if (typeof value !== 'string')
      throw new Error(`${name}: branch ${payload} has no string ${key}`)
    return { value, name: ident(camel(value)), payload }
  })
  const body: Lines = []
  if (nested.length) body.push(...nested, '')
  body.push(
    ...cases.map((c) => `case ${c.name}(${c.payload})`),
    `/// A \`${key}\` this build does not know: the whole object, untouched.`,
    'case unknown(JSONValue)',
    '',
    `private enum Tag: String, CodingKey {`,
    `    case ${ident(key)}${KEYWORDS.has(key) ? ` = "${key}"` : ''}`,
    '}',
    '',
    'public init(from decoder: any Decoder) throws {',
    `    let tag = try decoder.container(keyedBy: Tag.self).decode(String.self, forKey: .${ident(key)})`,
    '    switch tag {',
    ...cases.map(
      (c) =>
        `    case ${JSON.stringify(c.value)}: self = .${c.name}(try ${c.payload}(from: decoder))`
    ),
    '    default: self = .unknown(try JSONValue(from: decoder))',
    '    }',
    '}',
    '',
    'public func encode(to encoder: any Encoder) throws {',
    '    switch self {',
    ...cases.map(
      (c) =>
        `    case .${c.name}(let value): try Self.encode(tag: ${JSON.stringify(c.value)}, value, to: encoder)`
    ),
    '    case .unknown(let value): try value.encode(to: encoder)',
    '    }',
    '}',
    '',
    'private static func encode(tag: String, _ value: some Encodable, to encoder: any Encoder) throws {',
    '    var container = encoder.container(keyedBy: Tag.self)',
    `    try container.encode(tag, forKey: .${ident(key)})`,
    '    try value.encode(to: encoder)',
    '}'
  )
  return [`public enum ${name}: Codable, Hashable, Sendable {`, ...indent(body), '}']
}

/** Branch types with no name of their own land in `parent` (the enclosing
 *  struct, so `ToolPreview.Line` beside `ToolPreview.Lines`), else inside. */
function untaggedUnion(
  em: Emitter,
  name: string,
  branches: JS[],
  direction: 'in' | 'out',
  parent: Lines | null = null
): Lines {
  const nested: Lines = []
  const cases = branches.map((b, i) => {
    const r = resolve_(
      em,
      b,
      b.type === 'array' ? singular(name) : `${name}Case${i}`,
      direction,
      parent ?? nested
    )
    const caseName = b.$ref
      ? camel(r.type)
      : b.enum && em.enumNames.get(enumKey(b.enum))
        ? camel(r.type)
        : b.type === 'array'
          ? 'array'
          : b.type === 'object'
            ? 'object'
            : b.type === 'boolean'
              ? 'bool'
              : (b.type ?? 'value')
    return { name: ident(caseName), type: r.type }
  })
  const body: Lines = []
  if (nested.length) body.push(...nested, '')
  body.push(
    ...cases.map((c) => `case ${c.name}(${c.type})`),
    '/// A shape this build does not know, untouched.',
    'case unknown(JSONValue)',
    '',
    'public init(from decoder: any Decoder) throws {',
    '    let container = try decoder.singleValueContainer()',
    ...cases.map(
      (c) =>
        `    if let value = try? container.decode(${c.type}.self) { self = .${c.name}(value); return }`
    ),
    '    self = .unknown(try container.decode(JSONValue.self))',
    '}',
    '',
    'public func encode(to encoder: any Encoder) throws {',
    '    var container = encoder.singleValueContainer()',
    '    switch self {',
    ...cases.map((c) => `    case .${c.name}(let value): try container.encode(value)`),
    '    case .unknown(let value): try container.encode(value)',
    '    }',
    '}'
  )
  return [`public enum ${name}: Codable, Hashable, Sendable {`, ...indent(body), '}']
}

/** A named definition from the subset as a top-level declaration. */
function declaration(em: Emitter, name: string, schema: JS): Lines {
  const sink: Lines = []
  if (schema.enum) return stringEnum(name, schema.enum)
  if (schema.oneOf)
    return taggedUnion(em, name, schema.oneOf, discriminatorOf(em, schema.oneOf), 'out')
  if (schema.anyOf) {
    const branches = schema.anyOf.filter((b) => b.type !== 'null')
    if (branches.length > 1) return untaggedUnion(em, name, branches, 'out')
  }
  if (schema.type === 'object' && schema.properties)
    return struct(em, name, schema, 'out', em.branchKeys.get(name) ?? null)
  const r = resolve_(em, schema, name, 'out', sink)
  return [...sink, `public typealias ${name} = ${r.type}${r.nullable ? '?' : ''}`]
}

function methodDeclaration(em: Emitter, shape: MethodShape): Lines {
  const name = methodTypeName(shape.method)
  const body: Lines = [`public static let name = ${JSON.stringify(shape.method)}`, '']
  if (!shape.paramsId) body.push('public typealias Params = NoParams')
  else if (shape.paramsId.startsWith(PARAMS))
    body.push(...struct(em, 'Params', em.defs[shape.paramsId], 'in', null))
  else body.push(`public typealias Params = ${named(em, shape.paramsId)}`)
  body.push('')
  const output = em.defs[shape.outputId]
  if (!shape.outputId.startsWith(OUTPUT))
    body.push(`public typealias Output = ${named(em, shape.outputId)}`)
  else if (output.type === 'object' && output.properties)
    body.push(...struct(em, 'Output', output, 'out', null))
  else {
    const sink: Lines = []
    const r = resolve_(em, output, 'Output', 'out', sink)
    body.push(...sink, `public typealias Output = ${r.type}${r.nullable ? '?' : ''}`)
  }
  return [`public enum ${name}: ContractMethod {`, ...indent(body), '}']
}

const HEADER = [
  '// Generated by scripts/gen-swift-contract.ts from src/shared — do not edit.',
  '// Regenerate with `bun run gen:swift`; `bun run check:swift-contract` fails the gate when this is stale.',
  ''
]

export function generate(): Record<string, string> {
  const { defs, methods } = jsonSchemas()
  const em: Emitter = { defs, enumNames: new Map(), branchKeys: new Map(), shadowed: new Set() }
  for (const entry of SUBSET) {
    if (entry.kind === 'type' && defs[entry.id]?.enum)
      em.enumNames.set(enumKey(defs[entry.id].enum!), entry.id)
    if (entry.kind === 'union') {
      for (const branch of defs[entry.id].oneOf ?? [])
        if (branch.$ref) em.branchKeys.set(refName(branch.$ref), entry.discriminator)
    }
  }
  const files: Record<string, Lines> = { 'Enums.swift': [], 'Types.swift': [] }
  const push = (file: string, lines: Lines): void => {
    files[file] ??= []
    if (files[file].length) files[file].push('')
    files[file].push(...lines)
  }
  for (const entry of SUBSET) {
    if (entry.kind === 'type')
      push(
        defs[entry.id].enum ? 'Enums.swift' : 'Types.swift',
        declaration(em, entry.id, defs[entry.id])
      )
    else if (entry.kind === 'union') {
      const file = `${entry.id}.swift`
      for (const branch of defs[entry.id].oneOf ?? [])
        if (branch.$ref)
          push(file, declaration(em, refName(branch.$ref), defs[refName(branch.$ref)]))
      push(file, declaration(em, entry.id, defs[entry.id]))
    }
  }
  // `Methods`, not `Method`: Foundation re-exports the Objective-C runtime, whose `Method` would make the name ambiguous in every client file.
  const methodLines: Lines = [
    '/// One type per request method: its wire name, `Params` and `Output`.',
    'public enum Methods {'
  ]
  em.shadowed = new Set(methods.map((m) => methodTypeName(m.method)))
  for (const shape of methods) methodLines.push(...indent(methodDeclaration(em, shape)), '')
  em.shadowed = new Set()
  methodLines.pop()
  methodLines.push('}')
  files['Methods.swift'] = methodLines
  files['Contract.swift'] = [
    '/// `hello.contract` of the server this package was generated against (src/shared/capabilities.ts CONTRACT_VERSION).',
    `public let contractVersion: Int = ${CONTRACT_VERSION}`
  ]
  const out: Record<string, string> = {}
  for (const [file, lines] of Object.entries(files)) {
    const needsFoundation = lines.some(
      (l) => l.includes('JSONValue') || l.includes('Decoder') || l.includes('Encoder')
    )
    out[file] = [
      ...HEADER,
      ...(needsFoundation ? ['import Foundation', ''] : []),
      ...lines,
      ''
    ].join('\n')
  }
  return out
}

// ── files ───────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
export const GENERATED_DIR = resolve(
  here,
  '..',
  'ios',
  'TempCodeContract',
  'Sources',
  'TempCodeContract',
  'Generated'
)

function writeAll(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir))
    if (name.endsWith('.swift') && !(name in files)) rmSync(join(dir, name))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

function main(): void {
  const files = generate()
  if (process.argv.includes('--check')) {
    const tmp = mkdtempSync(join(tmpdir(), 'tc-swift-contract-'))
    try {
      writeAll(tmp, files)
      if (!existsSync(GENERATED_DIR)) {
        console.error(`check:swift-contract: ${GENERATED_DIR} is missing; run bun run gen:swift`)
        process.exit(1)
      }
      const diff = spawnSync('diff', ['-ru', GENERATED_DIR, tmp], { encoding: 'utf8' })
      if (diff.status !== 0) {
        console.error(diff.stdout || diff.stderr)
        console.error(
          'check:swift-contract: the Swift contract is stale — run bun run gen:swift and commit Generated/'
        )
        process.exit(1)
      }
      console.log(`check:swift-contract: ${Object.keys(files).length} files match`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    writeAll(GENERATED_DIR, files)
    for (const [name, text] of Object.entries(files))
      console.log(`${name}: ${text.split('\n').length} lines`)
  }
}

if (import.meta.main) main()
