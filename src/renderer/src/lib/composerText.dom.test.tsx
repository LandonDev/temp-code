// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  insertPlainText,
  positionsFor,
  readComposer,
  serializeComposer,
  snapshotSegments
} from './composerText'

/**
 * Explicit node trees stand in for what Chromium leaves behind in the
 * contenteditable: text, <br>, line divs, and chip spans.
 */
function root(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.append(el)
  return el
}

const chip = (token: string, name = 'linear') =>
  `<span data-token="${token}" data-name="${name}" contenteditable="false">Linear</span>`

describe('readComposer', () => {
  it('reads plain text with the caret at the end when there is no selection', () => {
    expect(readComposer(root('hello'), null)).toEqual({ text: 'hello', caret: 5, chips: [] })
  })

  it('reads a caret inside a text node', () => {
    const el = root('hello world')
    expect(readComposer(el, { node: el.firstChild!, offset: 3 }).caret).toBe(3)
  })

  it('serializes br as a newline and line divs as newlines after the first', () => {
    expect(serializeComposer(root('a<br>b'))).toBe('a\nb')
    expect(serializeComposer(root('<div>a</div><div>b</div>'))).toBe('a\nb')
    expect(serializeComposer(root('a<div>b</div>'))).toBe('a\nb')
  })

  it('reports chip spans as the token, shifted for a leading line div', () => {
    const plain = root(`ask ${chip('/linear')} now`)
    expect(readComposer(plain, null)).toEqual({
      text: 'ask /linear now',
      caret: 15,
      chips: [[4, 11]]
    })
    const wrapped = root(`<div>${chip('/linear')} x</div>`)
    expect(readComposer(wrapped, null)).toEqual({ text: '/linear x', caret: 9, chips: [[0, 7]] })
  })

  it('places a caret between children by child index, and inside a chip after it', () => {
    const el = root(`a${chip('/linear')}b`)
    expect(readComposer(el, { node: el, offset: 1 }).caret).toBe(1)
    expect(readComposer(el, { node: el, offset: 2 }).caret).toBe(8)
    const label = el.querySelector('[data-token]')!.firstChild!
    expect(readComposer(el, { node: label, offset: 2 }).caret).toBe(8)
  })

  it('clamps the caret when the selection sits on the dropped leading newline', () => {
    const el = root('<div>abc</div>')
    expect(readComposer(el, { node: el, offset: 0 }).caret).toBe(0)
    expect(readComposer(el, { node: el.firstChild!.firstChild!, offset: 2 }).caret).toBe(2)
  })

  it('matches the snapshot segments and the text on a mixed tree', () => {
    const el = root(`one<br>two ${chip('/linear')} <div>three</div>`)
    expect(serializeComposer(el)).toBe('one\ntwo /linear \nthree')
    expect(snapshotSegments(el)).toEqual([
      { text: 'one\ntwo ' },
      { chip: { token: '/linear', name: 'linear' } },
      { text: ' \nthree' }
    ])
  })
})

describe('positionsFor', () => {
  it('resolves several offsets in one walk, in text nodes and around chips', () => {
    const el = root(`ab${chip('/linear')}cd`)
    const [a, b, c, d, e] = positionsFor(el, [0, 2, 9, 11, 40])
    expect(a).toEqual({ node: el.childNodes[0], offset: 0 })
    expect(b).toEqual({ node: el.childNodes[0], offset: 2 })
    expect(c).toEqual({ node: el, offset: 2 })
    expect(d).toEqual({ node: el.childNodes[2], offset: 2 })
    expect(e).toBeNull()
  })

  it('skips the first line div newline, counts later ones', () => {
    const el = root('<div>ab</div><div>cd</div>')
    const [start, second] = positionsFor(el, [0, 4])
    expect(start).toEqual({ node: el.childNodes[0].firstChild, offset: 0 })
    expect(second).toEqual({ node: el.childNodes[1].firstChild, offset: 1 })
    expect(serializeComposer(el).slice(4, 5)).toBe('d')
  })

  it('drops a leading br or a leading newline character like the reader does', () => {
    const br = root('<br>abc')
    expect(readComposer(br, null).text).toBe('abc')
    expect(positionsFor(br, [0, 3])).toEqual([
      { node: br.childNodes[1], offset: 0 },
      { node: br.childNodes[1], offset: 3 }
    ])
    const text = root('')
    text.append(document.createTextNode('\nabc'))
    expect(readComposer(text, null).text).toBe('abc')
    expect(positionsFor(text, [0, 2])).toEqual([
      { node: text.firstChild, offset: 1 },
      { node: text.firstChild, offset: 3 }
    ])
    // Only the first newline goes; a second one is a real line break.
    const two = root('<br><br>abc')
    expect(readComposer(two, null).text).toBe('\nabc')
    expect(positionsFor(two, [0, 1])).toEqual([
      { node: two, offset: 1 },
      { node: two.childNodes[2], offset: 0 }
    ])
  })

  it('agrees with the serialized text on a br tree', () => {
    const el = root('ab<br>cd')
    const text = serializeComposer(el)
    const positions = positionsFor(el, [1, 3, text.length])
    expect(positions[0]).toEqual({ node: el.childNodes[0], offset: 1 })
    expect(positions[1]).toEqual({ node: el.childNodes[2], offset: 0 })
    expect(positions[2]).toEqual({ node: el.childNodes[2], offset: 2 })
  })
})

describe('insertPlainText', () => {
  it('appends at the end when the selection is elsewhere and leaves the caret after', () => {
    const el = root('ab')
    window.getSelection()?.removeAllRanges()
    insertPlainText(el, 'cd\nef')
    expect(serializeComposer(el)).toBe('abcd\nef')
    const range = window.getSelection()!.getRangeAt(0)
    expect(range.collapsed).toBe(true)
    expect(readComposer(el, { node: range.endContainer, offset: range.endOffset }).caret).toBe(7)
  })

  it('replaces the selection inside the box in one mutation', () => {
    const el = root('hello world')
    const range = document.createRange()
    range.setStart(el.firstChild!, 6)
    range.setEnd(el.firstChild!, 11)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    insertPlainText(el, 'there')
    expect(serializeComposer(el)).toBe('hello there')
    expect(el.childNodes.length).toBeLessThanOrEqual(3)
  })

  it('drops the placeholder br of an empty box', () => {
    const el = root('<br>')
    window.getSelection()?.removeAllRanges()
    insertPlainText(el, 'x')
    expect(el.innerHTML).toBe('x')
  })
})
