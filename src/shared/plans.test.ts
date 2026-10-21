import { describe, expect, it } from 'vitest'
import {
  buildSpecFor,
  buildTitleFor,
  DEFAULT_PLAN_SETTINGS,
  parsePlanSettings,
  planDoneNotice,
  planHeadingOf
} from './plans'

const plan = { provider: 'claude' as const, model: 'claude-haiku-5-5', reasoning: 'high' as const, context1m: true }

describe('buildSpecFor', () => {
  it('inherits the plan thread\'s model, effort and context window by default', () => {
    expect(buildSpecFor(plan, DEFAULT_PLAN_SETTINGS)).toEqual({
      provider: 'claude',
      model: 'claude-haiku-5-5',
      reasoning: 'high',
      context1m: true
    })
  })
  it('each plans.implement* setting fixes its own value and leaves the rest inherited', () => {
    expect(buildSpecFor(plan, { ...DEFAULT_PLAN_SETTINGS, implementModel: 'gpt-6.1-sol' })).toMatchObject({ model: 'gpt-6.1-sol', reasoning: 'high', context1m: true })
    expect(buildSpecFor(plan, { ...DEFAULT_PLAN_SETTINGS, implementReasoning: 'low' })).toMatchObject({ model: 'claude-haiku-5-5', reasoning: 'low', context1m: true })
    expect(buildSpecFor(plan, { ...DEFAULT_PLAN_SETTINGS, implementContext: '200k' })).toMatchObject({ context1m: false })
    expect(buildSpecFor({ ...plan, context1m: false }, { ...DEFAULT_PLAN_SETTINGS, implementContext: '1m' })).toMatchObject({ context1m: true })
  })
})

describe('parsePlanSettings', () => {
  it('fills defaults and refuses garbage', () => {
    expect(parsePlanSettings(null)).toBeNull()
    expect(parsePlanSettings('{')).toBeNull()
    expect(parsePlanSettings('{"autoImplement":false}')).toEqual({ ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
    expect(parsePlanSettings('{"implementContext":"huge"}')).toBeNull()
  })
})

describe('titles and notices', () => {
  it('titles the build from the plan heading, else the thread title, without a Plan: prefix', () => {
    expect(planHeadingOf('intro\n# Ship the thing\n## Overview')).toBe('Ship the thing')
    expect(planHeadingOf('no heading')).toBeNull()
    expect(buildTitleFor('Plan: Ship it', null)).toBe('Ship it')
    expect(buildTitleFor('Plan: Ship it', 'Plan: Ship the thing')).toBe('Ship the thing')
    expect(buildTitleFor('Plan', '')).toBe('Implementation')
  })
  it('the notice names the plan, the file and the build or the wait', () => {
    expect(planDoneNotice({ title: 'T', planPath: '/p.md', planId: 'p', implementation: { id: 'i', host: 'box' }, autoImplement: true })).toBe(
      'Plan "T" is done: /p.md. Implementation thread i started on box.'
    )
    expect(planDoneNotice({ title: 'T', planPath: '/p.md', planId: 'p', implementation: null, autoImplement: false })).toContain('Waiting for you to start it')
    expect(planDoneNotice({ title: 'T', planPath: '/p.md', planId: 'p', implementation: null, autoImplement: true })).toContain('could not be started')
  })
})
