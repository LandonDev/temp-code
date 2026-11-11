import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { webProofFixtures, WEB_NONCE, WEB_TITLES } from './webProofFixtures'
import { FIELD_FORM, fieldFormCode } from './fieldTasks'

describe('web proof scratch pages', () => {
  it('has native tables with exactly 40 and 300 rows and a working local link', () => {
    const pages = webProofFixtures()
    for (const n of [40, 300]) {
      const dom = new JSDOM(pages[n === 40 ? 'report.html' : 'report300.html'])
      try {
        const doc = dom.window.document
        expect(doc.querySelectorAll('tbody tr')).toHaveLength(n)
        expect(doc.querySelector('tbody tr:last-child')?.textContent).toContain(
          `City ${String(n).padStart(3, '0')}`
        )
        expect(doc.querySelector('a')?.getAttribute('href')).toBe('report300.html')
        expect(doc.title).toBe(n === 40 ? WEB_TITLES.report : WEB_TITLES.large)
      } finally {
        dom.window.close()
      }
    }
  })
  it('submits only completed fields and derives confirmation from their values', () => {
    const dom = new JSDOM(webProofFixtures()['form.html'], { runScripts: 'dangerously' })
    try {
      const doc = dom.window.document
      const submit = () =>
        doc
          .querySelector('form')!
          .dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
      submit()
      expect(doc.getElementById('out')!.textContent).toBe('Please complete every field.')
      for (const [id, value] of [
        ['name', FIELD_FORM.name],
        ['email', FIELD_FORM.email],
        ['plan', FIELD_FORM.plan]
      ])
        (doc.getElementById(id) as HTMLInputElement).value = value
      ;(doc.getElementById('agree') as HTMLInputElement).checked = true
      submit()
      expect(doc.getElementById('out')!.textContent).toBe(
        `Confirmation: ${fieldFormCode(WEB_NONCE)}`
      )
    } finally {
      dom.window.close()
    }
  })
  it('rejects a select change on both input and change, with the old value readable', () => {
    const dom = new JSDOM(webProofFixtures()['refused.html'], { runScripts: 'dangerously' })
    try {
      const select = dom.window.document.querySelector('select')!
      for (const event of ['input', 'change']) {
        select.value = 'Team'
        select.dispatchEvent(new dom.window.Event(event))
        expect(select.value).toBe('Starter')
      }
    } finally {
      dom.window.close()
    }
  })
})
