import { describe, expect, it } from 'vitest'
import { AnswerSeam } from './answerSeams'

describe('AnswerSeam', () => {
  it('takes the first count requests of each named method', () => {
    const seam = new AnswerSeam('catalog.get:2, accounts.confirm')
    expect([seam.take('catalog.get'), seam.take('catalog.get'), seam.take('catalog.get')]).toEqual([true, true, false])
    expect([seam.take('accounts.confirm'), seam.take('accounts.confirm')]).toEqual([true, false])
    expect(seam.take('session.list')).toBe(false)
  })

  it('takes nothing without a spec, and what a proof adds in process', () => {
    const seam = new AnswerSeam(undefined)
    expect(seam.take('catalog.get')).toBe(false)
    expect(new AnswerSeam('').take('catalog.get')).toBe(false)
    seam.add('catalog.get', 2)
    expect([seam.take('catalog.get'), seam.take('catalog.get'), seam.take('catalog.get')]).toEqual([true, true, false])
  })
})
