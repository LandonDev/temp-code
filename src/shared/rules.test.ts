import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, ModelPolicySchema, OrchestrationRulesSchema, ThreadRulesSchema, modelApproved, policyRoleOf, type OrchestrationRules } from './rules'

it('maxParallel runs up to 128 in both the rules and a thread tune', () => {
  const at = (maxParallel: number) =>
    OrchestrationRulesSchema.safeParse({ ...DEFAULT_RULES, conduct: { ...DEFAULT_RULES.conduct, maxParallel } })
      .success
  expect(at(128)).toBe(true)
  expect(at(129)).toBe(false)
  expect(ThreadRulesSchema.safeParse({ conduct: { maxParallel: 128 } }).success).toBe(true)
  expect(ThreadRulesSchema.safeParse({ conduct: { maxParallel: 129 } }).success).toBe(false)
})

describe('model policy by role', () => {
  const rulesWith = (approved: boolean | 'orchestrators'): OrchestrationRules =>
    OrchestrationRulesSchema.parse({ ...DEFAULT_RULES, models: { 'claude:claude-opus-5-5': { approved } } })

  it('true approves both roles, false neither, orchestrators only the orchestrator', () => {
    for (const [approved, thread, orchestrator] of [
      [true, true, true],
      [false, false, false],
      ['orchestrators', false, true]
    ] as const) {
      const rules = rulesWith(approved)
      expect(modelApproved(rules, 'claude', 'claude-opus-5-5')).toBe(thread)
      expect(modelApproved(rules, 'claude', 'claude-opus-5-5', 'thread')).toBe(thread)
      expect(modelApproved(rules, 'claude', 'claude-opus-5-5', 'orchestrator')).toBe(orchestrator)
    }
  })

  it('a model with no policy is approved for both roles, and the union round-trips', () => {
    expect(modelApproved(DEFAULT_RULES, 'claude', 'claude-opus-5-5', 'orchestrator')).toBe(true)
    expect(modelApproved(DEFAULT_RULES, 'claude', 'claude-opus-5-5', 'thread')).toBe(true)
    const parsed = rulesWith('orchestrators')
    expect(parsed.models['claude:claude-opus-5-5'].approved).toBe('orchestrators')
    expect(ModelPolicySchema.safeParse({ approved: 'everyone' }).success).toBe(false)
  })

  it('the role follows the agent type or the thread type', () => {
    expect(policyRoleOf({ agentType: 'orchestrator', threadType: null })).toBe('orchestrator')
    expect(policyRoleOf({ agentType: 'implementer', threadType: 'orchestration' })).toBe('orchestrator')
    expect(policyRoleOf({ agentType: 'implementer', threadType: 'implementation' })).toBe('thread')
    expect(policyRoleOf({ agentType: null, threadType: 'chat' })).toBe('thread')
  })
})
