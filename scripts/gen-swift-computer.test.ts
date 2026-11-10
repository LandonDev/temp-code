import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_WORDS, KEY_NAMES, MODIFIER_NAMES, ROLE_DEFAULTS, ROLE_TAGS, STATE_WORDS } from '../src/shared/computer/observation'
import { COMPUTER_METHODS, COMPUTER_PROTOCOL, COMPUTER_WAIT, SCROLL_POINTS_PER_CLICK } from '../src/shared/computer/protocol'
import { GENERATED_DIR, generate, pascal } from './gen-swift-contract'
import { COMPUTER_GENERATED_DIR, INPUT_GENERATED_DIR, OBSERVATION_TABLES_DIR, emitInputTables, emitObservationTables, generateComputer } from './gen-swift-computer'
import { QUOTE_VECTORS_PATH, quoteVectors } from './quote-vectors'

// The computer wire's Swift, pinned on the generated text: the box cannot
// build the service, so the names the Swift threads code against are proven
// here, and the committed files are held to the generator.

const files = generateComputer()
const onDisk = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.swift')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
const declaration = (text: string, head: string): string => {
  const start = text.indexOf(head)
  expect(start, head).toBeGreaterThan(-1)
  return text.slice(start, text.indexOf('\n}\n', start))
}

describe('the computer Swift', () => {
  it('is deterministic and is what Generated/ holds', () => {
    expect(generateComputer()).toEqual(files)
    expect(onDisk(COMPUTER_GENERATED_DIR)).toEqual(files)
    expect(Object.keys(files).sort()).toEqual(['ComputerNotification.swift', 'Contract.swift', 'Enums.swift', 'HostNotification.swift', 'Methods.swift', 'StepResult.swift', 'Types.swift'])
  })

  it('leaves the iOS contract as it was', () => {
    expect(onDisk(GENERATED_DIR)).toEqual(generate())
  })

  it('makes a point an array of Ints and an app ref a struct of optionals', () => {
    const types = files['Types.swift']
    expect(types).toContain('public typealias Point = [Int]')
    expect(types).toContain('public typealias Region = [Int]')
    const appRef = declaration(types, 'public struct AppRef:')
    expect(appRef).toContain('public let app: String?')
    expect(appRef).toContain('public let pid: Int?')
  })

  it('makes an action one struct of optional fields, the native names kept', () => {
    const action = declaration(files['Types.swift'], 'public struct ComputerAction:')
    expect(action).toContain('public let action: ComputerActionName\n')
    for (const field of ['coordinate: Point?', 'element: Int?', 'start_coordinate: Point?', 'scroll_direction: ScrollDirection?', 'scroll_amount: Int?', '`repeat`: Int?', 'duration: Double?', 'range: [Int]?'])
      expect(action).toContain(`public let ${field}`)
    const names = declaration(files['Enums.swift'], 'public enum ComputerActionName')
    for (const c of ['case leftClick', 'case leftClickDrag', 'case holdKey', 'case selectText', 'case unknown(String)']) expect(names).toContain(c)
  })

  it('declares one method type per method and every union with an unknown case', () => {
    const methods = files['Methods.swift']
    for (const name of Object.keys(COMPUTER_METHODS)) expect(methods).toContain(`public enum ${pascal(name)}: ContractMethod`)
    expect(methods).toContain('public typealias Output = Observation')
    expect(methods).toContain('public typealias Params = Empty')
    for (const file of ['StepResult.swift', 'ComputerNotification.swift', 'HostNotification.swift']) expect(files[file]).toContain('case unknown(JSONValue)')
    expect(files['StepResult.swift']).toContain('case notRun(NotRunStep)')
    expect(files['ComputerNotification.swift']).toContain('case captureFrame(CaptureFrameNotification)')
    expect(files['HostNotification.swift']).toContain('case cancel(CancelHostNotification)')
  })

  it("writes the observation grammar's tables for the AX reader, and the committed file is that", () => {
    const tables = emitObservationTables()
    expect(readFileSync(join(OBSERVATION_TABLES_DIR, 'ObservationTables.swift'), 'utf8')).toBe(tables)
    expect(readdirSync(OBSERVATION_TABLES_DIR)).toEqual(['ObservationTables.swift'])
    for (const [key, word] of Object.entries(ROLE_TAGS)) expect(tables).toContain(`        ${JSON.stringify(key)}: ${JSON.stringify(word)}`)
    expect(tables).toContain('"pop up": ["press", "show menu"]')
    expect(tables).toContain('public static let ambientActions: Set<String> = ["AXShowMenu", "AXScrollToVisible"]')
    expect(tables).toContain(`public static let stateWords: [String] = [${STATE_WORDS.map((w) => JSON.stringify(w)).join(', ')}]`)
    expect(tables).toContain('public static let headerSeparator = " · "')
    expect(tables).not.toMatch(/\$\{|\\u/)
  })

  it("holds the AX reader's quoting vectors to JSON.stringify", () => {
    expect(readFileSync(QUOTE_VECTORS_PATH, 'utf8')).toBe(quoteVectors())
    for (const { input, quoted } of JSON.parse(quoteVectors()) as { input: string; quoted: string }[]) expect(quoted).toBe(JSON.stringify(input))
  })

  it('carries the protocol number and the defaults', () => {
    const contract = files['Contract.swift']
    expect(contract).toContain(`public let computerProtocol: Int = ${COMPUTER_PROTOCOL}`)
    const w = COMPUTER_WAIT.action
    expect(contract).toContain(`public static let action = WaitOptions(minMs: ${w.minMs}, quietMs: ${w.quietMs}, maxMs: ${w.maxMs}, busyMaxMs: ${w.busyMaxMs})`)
    expect(contract).toContain('public static let jpegQuality = 0.85')
    expect(contract).toContain('public static let computer = -32000')
    expect(contract).not.toMatch(/\$\{/)
  })

  it('carries the background fallbacks: the new vias, what a step acted on, the ignored routes, a disabled item', () => {
    const via = declaration(files['Enums.swift'], 'public enum InputVia')
    for (const c of ['case menu', 'case hit', 'case caret', 'case "scroll-bar": self = .scrollBar', 'case "scroll-page": self = .scrollPage']) expect(via).toContain(c)
    // appended: the typing routes keep their places
    expect(via.indexOf('axInsert')).toBeLessThan(via.indexOf('case menu'))
    const ignored = declaration(files['Types.swift'], 'public struct IgnoredRoutes:')
    for (const field of ['via: [InputVia]?', 'process: [ActionClass]?', 'skip: Bool?']) expect(ignored).toContain(`public let ${field}`)
    expect(declaration(files['Types.swift'], 'public struct ComputerError:')).toContain('public let menu: [String]?')
  })

  it('carries the new methods, the paste verb and a session change on the error', () => {
    const methods = files['Methods.swift']
    expect(methods).toContain('public enum InputProbe: ContractMethod')
    expect(methods).toContain('public typealias Output = SessionRestore')
    expect(declaration(files['Enums.swift'], 'public enum ComputerActionName')).toContain('case paste')
    const error = declaration(files['Types.swift'], 'public struct ComputerError:')
    for (const field of ['reason: ErrorReason?', 'keyWindow: KeyWindow?', 'session: SessionChange?']) expect(error).toContain(`public let ${field}`)
    expect(declaration(files['Types.swift'], 'public struct ProbeReport:')).toContain('public let `class`: ActionClass')
  })
})

describe('the Input tables', () => {
  const tables = emitInputTables()

  it('are deterministic and are what Input/Generated holds', () => {
    expect(emitInputTables()).toEqual(tables)
    expect(onDisk(INPUT_GENERATED_DIR)).toEqual(tables)
  })

  it('carry every key name, modifier alias, action word and role default of the grammar', () => {
    const text = tables['InputTables.swift']
    for (const [k, v] of Object.entries(KEY_NAMES)) expect(text).toContain(`        ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    for (const [k, v] of Object.entries(MODIFIER_NAMES)) expect(text).toContain(`        ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    for (const [k, v] of Object.entries(ACTION_WORDS)) expect(text).toContain(`        ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    expect(text).toContain('"row": ["press", "expand", "collapse"],')
    expect(Object.keys(ROLE_DEFAULTS).every((r) => text.includes(`        ${JSON.stringify(r)}: [`))).toBe(true)
    expect(text).toContain('public static let modifiers: [String] = ["shift", "ctrl", "alt", "super"]')
    expect(text).not.toMatch(/\\u[0-9a-fA-F]{4}/)
  })

  it('carry the scroll bar distance per wheel click', () => {
    expect(tables['InputTables.swift']).toContain(`public static let scrollPointsPerClick = ${SCROLL_POINTS_PER_CLICK}`)
  })
})
