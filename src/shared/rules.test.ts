import { expect, it } from 'vitest'
import { OrchestrationRulesSchema, ThreadRulesSchema, DEFAULT_RULES } from './rules'

it('maxParallel runs up to 128 in both the rules and a thread tune', () => {
  const at = (maxParallel: number) =>
    OrchestrationRulesSchema.safeParse({ ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel } })
      .success
  expect(at(128)).toBe(true)
  expect(at(129)).toBe(false)
  expect(ThreadRulesSchema.safeParse({ conduct: { maxParallel: 128 } }).success).toBe(true)
  expect(ThreadRulesSchema.safeParse({ conduct: { maxParallel: 129 } }).success).toBe(false)
})
