/** Unattended computer proofs share the same grant and request rules. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceStamp } from './tcComputerBuild'
import { otherProof } from './proofOrder'

export function computerProofMode(argv: readonly string[]) {
  const gate = argv.includes('--gate')
  const pair = argv[argv.indexOf('--pair') + 1]
  return { gate, localPair: gate || (argv.includes('--pair') && pair === 'local') }
}

/**
 * A try that did not run whole (the screen locked, slept or went dark, or
 * no gap came): a hand run waits for the next gap, but the gate fails, since
 * its pass must mean every check ran.
 */
export const lostTry = (gate: boolean): 'retry' | 'fail' => (gate ? 'fail' : 'retry')
export const LOST_TRY_LINE = 'the gate proof lost the screen before its checks ran whole (locked, asleep or dark): inconclusive, so the row fails'

export const SCREEN_RECORDING_PROMPTED = 'computer.prompted.screenRecording'
export interface ProofGrants {
  accessibility: boolean
  screenRecording: boolean
}

/** Pure: callers seed these settings before their host starts, and use this rule on every call. */
export function computerProofPolicy(gate: boolean, grants: ProofGrants) {
  return {
    pictures: grants.screenRecording,
    escapeWatch: !gate,
    settings: grants.screenRecording
      ? []
      : ([[SCREEN_RECORDING_PROMPTED, '1']] as [string, string][]),
    observeArgs: <T extends Record<string, unknown>>(args: T): T & { screenshot?: boolean } =>
      grants.screenRecording ? args : { ...args, screenshot: false },
    assertRequest(method: string, params: unknown): void {
      const p = (params ?? {}) as Record<string, unknown>
      if (gate && method === 'escape.watch' && p.on === true)
        throw new Error('gate mode cannot take Escape')
      if (method === 'permissions.request')
        throw new Error('computer proofs never request a permission')
      if (grants.screenRecording) return
      const observe = p.observe as Record<string, unknown> | undefined
      const actions = [p.action, ...(Array.isArray(p.actions) ? p.actions : [])]
      if (
        method === 'capture.screenshot' ||
        method === 'capture.stream.start' ||
        (method === 'state.get' && p.screenshot !== 'never') ||
        (['action.run', 'action.batch'].includes(method) &&
          observe?.mode !== 'none' &&
          observe?.screenshot !== 'never') ||
        (['computer_observe', 'computer_act', 'computer_batch'].includes(method) &&
          p.screenshot !== false) ||
        ['screenshot', 'zoom'].includes(String(p.action)) ||
        p.screenshot === true ||
        p.screenshot === 'always' ||
        p.screenshot === 'auto' ||
        actions.some(
          (a) =>
            a &&
            typeof a === 'object' &&
            ['screenshot', 'zoom'].includes(String((a as Record<string, unknown>).action))
        ) ||
        (p.observe &&
          typeof p.observe === 'object' &&
          (observe?.screenshot === true ||
            observe?.screenshot === 'always' ||
            observe?.screenshot === 'auto'))
      )
        throw new Error('Screen Recording is off: picture call refused by the proof')
    }
  }
}

/** All rows use the wrapper's age ordering, with a bounded wait inside their row budget. */
export async function waitForComputerProof(
  log: (line: string) => void,
  timeoutMs = 10 * 60_000
): Promise<void> {
  const end = Date.now() + timeoutMs
  let said = false
  for (;;) {
    const other = otherProof()
    if (!other) return
    if (Date.now() >= end) throw new Error(`another computer proof still runs: ${other}`)
    if (!said) log(`waiting for the older computer proof: ${other}`)
    said = true
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/** A gate may only read the shipped service; fail before buildTcComputer could rebuild it. */
export function requireGateNative(root: string): void {
  const binary = join(root, 'resources/native/tc-computer')
  let stamp = ''
  try {
    stamp = JSON.parse(readFileSync(`${binary}.stamp`, 'utf8')).stamp
  } catch {
    /* missing stamp */
  }
  if (!existsSync(binary) || stamp !== sourceStamp(root))
    throw new Error('gate needs the current shipped tc-computer; run the native app build first')
}
