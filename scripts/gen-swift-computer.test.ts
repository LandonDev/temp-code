import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPUTER_METHODS, COMPUTER_PROTOCOL, COMPUTER_WAIT } from '../src/shared/computer/protocol'
import { GENERATED_DIR, generate, pascal } from './gen-swift-contract'
import { COMPUTER_GENERATED_DIR, generateComputer } from './gen-swift-computer'

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

  it('carries the protocol number and the defaults', () => {
    const contract = files['Contract.swift']
    expect(contract).toContain(`public let computerProtocol: Int = ${COMPUTER_PROTOCOL}`)
    const w = COMPUTER_WAIT.action
    expect(contract).toContain(`public static let action = WaitOptions(minMs: ${w.minMs}, quietMs: ${w.quietMs}, maxMs: ${w.maxMs}, busyMaxMs: ${w.busyMaxMs})`)
    expect(contract).toContain('public static let jpegQuality = 0.85')
    expect(contract).toContain('public static let computer = -32000')
    expect(contract).not.toMatch(/\$\{/)
  })
})
