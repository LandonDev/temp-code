import { describe, expect, it } from 'vitest'
import { CONFIRM_KINDS, CONFIRM_KIND_INFO, CONFIRM_TITLE_MAX, ConfirmSchema, HOST_CONFIRM_KINDS, confirmInput, confirmTitle } from './policy'

describe('the confirm flag', () => {
  it('takes a kind of the policy and one line of what happens', () => {
    expect(ConfirmSchema.safeParse({ kind: 'send', what: "Reply to Ana accepting Friday's lunch" }).success).toBe(true)
    expect(ConfirmSchema.safeParse({ kind: 'password', what: 'x' }).success).toBe(false)
    expect(ConfirmSchema.safeParse({ kind: 'send', what: '' }).success).toBe(false)
    expect(ConfirmSchema.safeParse({ kind: 'send', what: 'x'.repeat(201) }).success).toBe(false)
    expect(ConfirmSchema.safeParse({ kind: 'send' }).success).toBe(false)
  })

  it('leaves password to the host', () => {
    expect(CONFIRM_KINDS).not.toContain('password')
    expect(HOST_CONFIRM_KINDS).toEqual([...CONFIRM_KINDS, 'password'])
  })

  it('labels every kind, and only the plan’s six are pre-approvable', () => {
    for (const kind of HOST_CONFIRM_KINDS) {
      expect(CONFIRM_KIND_INFO[kind].label.length).toBeGreaterThan(0)
      expect(CONFIRM_KIND_INFO[kind].word.length).toBeGreaterThan(0)
    }
    expect(HOST_CONFIRM_KINDS.filter((k) => CONFIRM_KIND_INFO[k].preApprovable)).toEqual([
      'sign_in',
      'site_permission',
      'warning',
      'upload',
      'files',
      'personal_data'
    ])
  })
})

describe('the card title', () => {
  it('reads the examples', () => {
    expect(confirmTitle({ kind: 'send', what: "Reply to Ana accepting Friday's lunch" }, 'Mail', 'click button "Send"')).toBe(
      'Send in Mail: Reply to Ana accepting Friday\'s lunch (click button "Send")'
    )
    expect(confirmTitle({ kind: 'delete', what: 'Move the folder "Old drafts" to the Trash' }, 'Finder')).toBe(
      'Delete in Finder: Move the folder "Old drafts" to the Trash'
    )
    expect(confirmTitle({ kind: 'password', what: 'the password for example.com' }, 'Safari', 'type into [12] password "Password"')).toBe(
      'Type into a password field in Safari: the password for example.com (type into [12] password "Password")'
    )
  })

  it('drops the step words when the whole would pass 160 characters', () => {
    const what = 'w'.repeat(100)
    const steps = 's'.repeat(60)
    const head = `Send in Mail: ${what}`
    expect(head.length + steps.length + 3).toBeGreaterThan(CONFIRM_TITLE_MAX)
    expect(confirmTitle({ kind: 'send', what }, 'Mail', steps)).toBe(head)
    const fits = 's'.repeat(CONFIRM_TITLE_MAX - head.length - 3)
    expect(confirmTitle({ kind: 'send', what }, 'Mail', fits)).toHaveLength(CONFIRM_TITLE_MAX)
  })

  it('gives the card its label', () => {
    expect(confirmInput({ kind: 'pay', what: 'Order 2 tickets' })).toEqual({ kind: 'pay', label: 'Pay', what: 'Order 2 tickets' })
  })
})
