/**
 * One call's steps across the requests the host splits it into (docs/computer-protocol.md §27.7b, §27.8). The service
 * runs the same rule within a request (native/tc-computer/Sources/ComputerServiceKit/BatchStop.swift); both are held to
 * one table of cases, src/main/server/computer/fixtures/batch-stop.json.
 */
import { NO_INPUT_ACTIONS, type ComputerAction, type Prior, type StepEffect, type StepResult } from './protocol'

/** The steps that send keys or text. */
export const KEY_TEXT_ACTIONS: readonly ComputerAction['action'][] = ['type', 'paste', 'key', 'hold_key']

/** A key or text step that names no target: it goes wherever the focus is. */
export function typesBlind(action: Pick<ComputerAction, 'action' | 'element' | 'named'>): boolean {
  return KEY_TEXT_ACTIONS.includes(action.action) && action.element === undefined && action.named === undefined
}

/**
 * §27.8: the step at `at` and every step after it do not run when the last step that sent input changed nothing and
 * this one types blind. `lastEffect` is that step's effect, from this request or from `prior`; `unknown` (a thin tree)
 * does not stop it.
 */
export function stopsHere(lastEffect: StepEffect | undefined, action: Pick<ComputerAction, 'action' | 'element' | 'named'>): boolean {
  return lastEffect === 'none' && typesBlind(action)
}

/** The effect a later step reads as the one before it: the last step that ran and sent input. */
export function lastInputEffect(actions: readonly Pick<ComputerAction, 'action'>[], steps: readonly StepResult[], carried?: StepEffect): StepEffect | undefined {
  let effect = carried
  for (const step of steps) {
    if (step.status !== 'ok' || NO_INPUT_ACTIONS.includes(actions[step.index]?.action ?? step.action)) continue
    effect = step.effect
  }
  return effect
}

/**
 * §27.7b: what the call's segments so far tell the next one. `actions` and `steps` are the segments' own, in order;
 * `carried` is the prior the last of them was sent with.
 */
export function buildPrior(actions: readonly ComputerAction[], steps: readonly StepResult[], carried?: Prior): Prior {
  const targeted = new Set(carried?.targeted ?? [])
  const windows = new Set(carried?.windows ?? [])
  let focusTo = carried?.focusTo
  for (const step of steps) {
    if (step.status !== 'ok') continue
    const action = actions[step.index]
    for (const i of [action?.element, action?.start_element, step.resolved]) if (i !== undefined) targeted.add(i)
    if (step.opened) windows.add(step.opened.id)
    if (!NO_INPUT_ACTIONS.includes(step.action)) focusTo = step.focusTo
  }
  const effect = lastInputEffect(actions, steps, carried?.effect) ?? 'unknown'
  return {
    effect,
    ...(focusTo !== undefined ? { focusTo } : {}),
    targeted: [...targeted],
    ...(windows.size ? { windows: [...windows] } : {})
  }
}
