import { describe, expect, it } from 'vitest'
import { CATALOG, type Reasoning } from './catalog'
import { DEFAULT_RULES, ModelPolicySchema, OrchestrationRulesSchema, RoutingRuleSchema, ThreadRulesSchema, defaultApproval, explicitModels, fitReasoning, sliceLadder, withProbedDefaults, modelApproved, parseRules, policyRoleOf, type OrchestrationRules } from './rules'

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

  it("a project's master thread is an orchestrator whatever its type", () => {
    expect(policyRoleOf({ agentType: null, threadType: 'chat' }, true)).toBe('orchestrator')
    expect(policyRoleOf({ agentType: null, threadType: 'chat' }, false)).toBe('thread')
  })

  it('Fable defaults to orchestrators only; every other model to everyone', () => {
    for (const id of ['claude-fable-5-1', 'claude-fable-5']) {
      expect(modelApproved(DEFAULT_RULES, 'claude', id, 'thread')).toBe(false)
      expect(modelApproved(DEFAULT_RULES, 'claude', id, 'orchestrator')).toBe(true)
      // Orchestrators-only keeps the full ladder: the bound is who, not how hard.
      expect(fitReasoning(DEFAULT_RULES, 'claude', id, 'high')).toBe('high')
    }
    expect(modelApproved(DEFAULT_RULES, 'claude', 'claude-opus-5-5', 'thread')).toBe(true)
    expect(modelApproved(DEFAULT_RULES, 'codex', 'gpt-6.1-sol', 'thread')).toBe(true)
  })

  it('Muse Wonder Full is orchestrators only, Spark and Wonder for everyone, probed rows written out the same way', () => {
    expect(defaultApproval('muse', 'muse-wonder-1.0-full')).toBe('orchestrators')
    expect(defaultApproval('muse', 'muse-wonder-1.0')).toBe(true)
    expect(defaultApproval('muse', 'muse-spark-1.3')).toBe(true)
    expect(defaultApproval('claude', 'claude-fable-5-1')).toBe('orchestrators')
    expect(defaultApproval('codex', 'gpt-6.1-sol')).toBe(true)
    const before = CATALOG.muse.models
    CATALOG.muse.models = [
      { id: 'muse-spark-1.3', label: 'Spark', reasoning: [] },
      { id: 'muse-wonder-1.0-full', label: 'Wonder Full', reasoning: [] }
    ]
    try {
      const written = explicitModels({ ...DEFAULT_RULES, models: {} })
      expect(written.models['muse:muse-spark-1.3']).toEqual({ approved: true })
      expect(written.models['muse:muse-wonder-1.0-full']).toEqual({ approved: 'orchestrators' })
    } finally {
      CATALOG.muse.models = before
    }
  })

  it('gives a probed row the copy never decided its default where the rules are read, and keeps a decision', () => {
    const before = CATALOG.muse.models
    CATALOG.muse.models = [
      { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', reasoning: ['low', 'high'] },
      { id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: [] },
      { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', reasoning: [] }
    ]
    try {
      // DEFAULT_RULES was built before the probe: it names no Muse row.
      expect(DEFAULT_RULES.models['muse:muse-wonder-1.0']).toBeUndefined()
      const saved: OrchestrationRules = {
        ...DEFAULT_RULES,
        models: { 'muse:muse-spark-1.3': { approved: false }, 'claude:claude-opus-5-5': { approved: true } }
      }
      const read = withProbedDefaults(saved)
      expect(read.models['muse:muse-wonder-1.0']).toEqual({ approved: true })
      expect(read.models['muse:muse-wonder-full-1.0']).toEqual({ approved: 'orchestrators' })
      // The person's Off stands, and a static model the copy lacks stays off.
      expect(read.models['muse:muse-spark-1.3']).toEqual({ approved: false })
      expect(modelApproved(read, 'claude', 'claude-fable-5-1', 'orchestrator')).toBe(false)
      // What the page shows is what a spawn reads.
      expect(modelApproved(read, 'muse', 'muse-wonder-full-1.0', 'thread')).toBe(false)
      expect(modelApproved(read, 'muse', 'muse-wonder-full-1.0', 'orchestrator')).toBe(true)
      expect(modelApproved(read, 'muse', 'muse-wonder-1.0', 'thread')).toBe(true)
      // Nothing to add returns the same object; the saved copy is never written.
      expect(withProbedDefaults(read)).toBe(read)
      expect(saved.models['muse:muse-wonder-1.0']).toBeUndefined()
    } finally {
      CATALOG.muse.models = before
    }
  })

  it("reads another host's probed rows the same way: the box answers an undecided Muse row as the Mac does", () => {
    // The box serves no Muse row of its own.
    expect(CATALOG.muse.models).toEqual([])
    const saved: OrchestrationRules = { ...DEFAULT_RULES, models: { 'muse:muse-spark-1.3': { approved: false } } }
    const elsewhere = [
      { provider: 'muse' as const, id: 'muse-wonder-1.0' },
      { provider: 'muse' as const, id: 'muse-wonder-full-1.0' },
      { provider: 'muse' as const, id: 'muse-spark-1.3' },
      { provider: 'muse' as const, id: 'muse-wonder-1.0' }
    ]
    const read = withProbedDefaults(saved, elsewhere)
    expect(read.models['muse:muse-wonder-1.0']).toEqual({ approved: true })
    expect(read.models['muse:muse-wonder-full-1.0']).toEqual({ approved: 'orchestrators' })
    expect(read.models['muse:muse-spark-1.3']).toEqual({ approved: false })
    expect(withProbedDefaults(saved)).toBe(saved)
  })

  it("fits an effort to the row of the host that runs it, which this host's catalog may lack", () => {
    const rules: OrchestrationRules = { ...DEFAULT_RULES, models: { 'muse:muse-wonder-full-1.0': { approved: true, minReasoning: 'low', maxReasoning: 'xhigh' } } }
    const row = { id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'] as Reasoning[], defaultReasoning: 'max' as const }
    expect(fitReasoning(rules, 'muse', 'muse-wonder-full-1.0', 'max', row)).toBe('xhigh')
    expect(fitReasoning(rules, 'muse', 'muse-wonder-full-1.0', undefined, row)).toBe('xhigh')
    expect(fitReasoning(rules, 'muse', 'muse-wonder-full-1.0', 'medium', row)).toBe('medium')
    // Read off this host's catalog alone, the model has no ladder at all.
    expect(fitReasoning(rules, 'muse', 'muse-wonder-full-1.0', 'max')).toBe('medium')
  })

  it('slices a ladder the caller holds by the policy bounds', () => {
    const rules: OrchestrationRules = { ...DEFAULT_RULES, models: { 'muse:w': { approved: true, minReasoning: 'medium' } } }
    expect(sliceLadder(rules, 'muse', 'w', ['low', 'medium', 'high'])).toEqual(['medium', 'high'])
    expect(sliceLadder(rules, 'muse', 'other', ['low', 'high'])).toEqual(['low', 'high'])
  })

  it('a saved rules object keeps its own model map; a model it does not mention is off', () => {
    const saved = parseRules(JSON.stringify({ ...DEFAULT_RULES, models: {} }))!
    expect(saved.models).toEqual({})
    expect(modelApproved(saved, 'claude', 'claude-fable-5-1', 'orchestrator')).toBe(false)
    const own = parseRules(JSON.stringify({ ...DEFAULT_RULES, models: { 'claude:claude-fable-5-1': { approved: true } } }))!
    expect(modelApproved(own, 'claude', 'claude-fable-5-1', 'thread')).toBe(true)
    expect(modelApproved(own, 'claude', 'claude-fable-5', 'thread')).toBe(false)
  })
})

describe('Meta rows and the minimal rung', () => {
  const META = ['muse-wonder-1.0', 'muse-spark-1.3']

  it('are approved for everyone by default, under both harnesses', () => {
    for (const p of ['claude', 'codex'] as const)
      for (const id of META) expect(modelApproved(DEFAULT_RULES, p, id, 'thread')).toBe(true)
  })

  it('stay off in a copy saved before they existed, until the person turns them on', () => {
    const before = Object.fromEntries(Object.entries(DEFAULT_RULES.models).filter(([k]) => !k.includes('muse-')))
    // A legacy copy is written out once (explicitModels); the copy it writes
    // is what is saved, and a model added after that is not in it.
    const saved = parseRules(JSON.stringify({ ...DEFAULT_RULES, models: before }))!
    expect(Object.keys(saved.models).some((k) => k.includes('muse-'))).toBe(false)
    for (const p of ['claude', 'codex'] as const)
      for (const id of META) expect(modelApproved(saved, p, id, 'thread')).toBe(false)
    // The one-time upgrade writes every catalog model it lacked as approved.
    expect(modelApproved(explicitModels(saved), 'codex', 'muse-wonder-1.0', 'thread')).toBe(true)
  })

  it('takes minimal on the codex Meta row and clamps it to low on a row without it', () => {
    expect(fitReasoning(DEFAULT_RULES, 'codex', 'muse-wonder-1.0', 'minimal')).toBe('minimal')
    expect(fitReasoning(DEFAULT_RULES, 'claude', 'muse-wonder-1.0', 'minimal')).toBe('low')
    expect(fitReasoning(DEFAULT_RULES, 'codex', 'gpt-5.5', 'minimal')).toBe('low')
    // Off the top of a ladder the nearest rung wins as well.
    expect(fitReasoning(DEFAULT_RULES, 'claude', 'claude-opus-5-5', 'ultra')).toBe('max')
    expect(fitReasoning(DEFAULT_RULES, 'claude', 'muse-wonder-1.0', undefined)).toBe('high')
  })

  it('reads minimal in a routing rule and a policy bound', () => {
    expect(RoutingRuleSchema.parse({ id: 'x', task: 't', provider: 'codex', reasoning: 'minimal' }).reasoning).toBe('minimal')
    expect(ModelPolicySchema.parse({ minReasoning: 'minimal' }).minReasoning).toBe('minimal')
  })
})
