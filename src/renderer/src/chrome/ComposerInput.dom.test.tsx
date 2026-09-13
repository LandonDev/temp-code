// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { ComposerInput, type ComposerInputHandle } from './ComposerInput'
import { devRenders } from '../lib/devRenders'
import { PASTE_ATTACH_THRESHOLD } from '../lib/composerPaste'
import { mountProbe, Probe } from '../test/renderProbe'

/**
 * The input is uncontrolled, so keystrokes report through `onState` and
 * never re-render the component; pastes, composition and undo work on
 * the DOM directly and report once each.
 */
describe('ComposerInput under jsdom', () => {
  function mount(opts: { attachLargePastes?: (file: File) => void } = {}) {
    const onState = vi.fn()
    const onPaste = vi.fn()
    const onKeyDown = vi.fn()
    const ref = createRef<ComposerInputHandle>()
    const probe = mountProbe(
      <Probe id="input">
        <ComposerInput
          ref={ref}
          onState={onState}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          attachLargePastes={opts.attachLargePastes}
          placeholder="Ask"
          maxHeight={160}
        />
      </Probe>
    )
    const root = probe.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    return { onState, onPaste, onKeyDown, ref, probe, root }
  }

  function paste(root: HTMLElement, text: string): void {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: Pick<DataTransfer, 'getData' | 'types' | 'files' | 'items'>
    }
    event.clipboardData = {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList
    }
    root.dispatchEvent(event)
  }

  function type(root: HTMLElement, text: string): void {
    root.append(document.createTextNode(text))
    root.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('mounts once and tallies the mount', () => {
    const before = devRenders.composerInput ?? 0
    const { probe, root } = mount()
    expect(root).toBeTruthy()
    expect(probe.renders('input')).toBe(1)
    expect(devRenders.composerInput).toBe(before + 1)
  })

  it('20 keystrokes report 20 states and render the input zero more times', () => {
    const { onState, probe, root } = mount()
    for (let i = 0; i < 20; i++) probe.act(() => type(root, 'a'))
    expect(onState).toHaveBeenCalledTimes(20)
    expect(onState.mock.lastCall?.[0]).toBe('a'.repeat(20))
    expect(probe.renders('input')).toBe(1)
  })

  it('re-renders when the parent hands it new tokens', () => {
    const { probe } = mount()
    probe.rerender(
      <Probe id="input">
        <ComposerInput
          onState={() => {}}
          onKeyDown={() => {}}
          onPaste={() => {}}
          placeholder="Ask"
          maxHeight={160}
          tokens={[{ start: 0, end: 1, kind: 'skill' }]}
        />
      </Probe>
    )
    expect(probe.renders('input')).toBe(2)
  })

  it('a 50 KB paste becomes one file when the parent takes large pastes', () => {
    const attachLargePastes = vi.fn()
    const { onState, probe, root } = mount({ attachLargePastes })
    const big = 'line\n'.repeat(10_000)
    expect(big.length).toBeGreaterThan(PASTE_ATTACH_THRESHOLD)
    probe.act(() => paste(root, big))
    expect(attachLargePastes).toHaveBeenCalledTimes(1)
    const file = attachLargePastes.mock.calls[0][0] as File
    expect(file.type).toBe('text/plain')
    expect(file.size).toBe(big.length)
    expect(root.textContent).toBe('')
    expect(onState).not.toHaveBeenCalled()
    expect(probe.renders('input')).toBe(1)
  })

  it('a 50 KB paste goes inline as one text node and one report without a taker', () => {
    const { onState, probe, root } = mount()
    const big = 'line\n'.repeat(10_000)
    probe.act(() => paste(root, big))
    expect(root.childNodes.length).toBe(1)
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState.mock.lastCall?.[0]).toBe(big)
    expect(onState.mock.lastCall?.[1]).toBe(big.length)
    expect(probe.renders('input')).toBe(1)
  })

  it('a small paste is typed at the caret and normalizes line endings', () => {
    const attachLargePastes = vi.fn()
    const { onState, root, probe } = mount({ attachLargePastes })
    probe.act(() => paste(root, 'a\r\nb'))
    expect(attachLargePastes).not.toHaveBeenCalled()
    expect(onState.mock.lastCall?.[0]).toBe('a\nb')
  })

  it('the parent paste handler wins when it prevents default', () => {
    const { onPaste, onState, root, probe } = mount()
    onPaste.mockImplementation((e: Event) => e.preventDefault())
    probe.act(() => paste(root, 'ignored'))
    expect(root.textContent).toBe('')
    expect(onState).not.toHaveBeenCalled()
  })

  it('one ⌘Z after a paste takes the whole pasted block back', () => {
    const { onState, onKeyDown, root, probe } = mount()
    probe.act(() => type(root, 'before '))
    probe.act(() => paste(root, 'pasted block'))
    expect(onState.mock.lastCall?.[0]).toBe('before pasted block')
    probe.act(() => {
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(onState.mock.lastCall?.[0]).toBe('before ')
    expect(onKeyDown).not.toHaveBeenCalled()
    // The second ⌘Z is the browser's own again.
    probe.act(() => {
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('after typing, ⌘Z is the browser\'s until the box is back to the pasted text', () => {
    const { onKeyDown, onState, root, probe } = mount()
    const undoKey = () =>
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    probe.act(() => paste(root, 'pasted'))
    probe.act(() => type(root, '!'))
    probe.act(undoKey)
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(root.textContent).toBe('pasted!')
    // The browser undoes the typed "!"; the next ⌘Z is ours again.
    probe.act(() => {
      root.lastChild!.remove()
      root.dispatchEvent(new Event('input', { bubbles: true }))
    })
    probe.act(undoKey)
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(root.textContent).toBe('')
    expect(onState.mock.lastCall?.[0]).toBe('')
  })

  it('undoing a paste puts the caret back where the paste went', () => {
    const { onState, root, probe } = mount()
    probe.act(() => type(root, 'ab'))
    const range = document.createRange()
    range.setStart(root.firstChild!, 1)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    root.focus()
    sel.removeAllRanges()
    sel.addRange(range)
    probe.act(() => paste(root, 'XYZ'))
    expect(onState.mock.lastCall?.[0]).toBe('aXYZb')
    probe.act(() => {
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(onState.mock.lastCall?.[0]).toBe('ab')
    expect(onState.mock.lastCall?.[1]).toBe(1)
  })

  it('repaints the highlights after a rebuild, since their ranges died with the old nodes', () => {
    const highlights = CSS.highlights as unknown as Map<string, { ranges: Range[] }>
    const { ref, probe } = mount()
    probe.rerender(
      <Probe id="input">
        <ComposerInput
          ref={ref}
          onState={() => {}}
          onKeyDown={() => {}}
          onPaste={() => {}}
          placeholder="Ask"
          maxHeight={160}
          tokens={[{ start: 0, end: 5, kind: 'skill' }]}
        />
      </Probe>
    )
    probe.act(() => ref.current!.restore([{ text: '/plan go' }]))
    const painted = highlights.get('composer-skill')!.ranges[0]
    expect(painted.toString()).toBe('/plan')
    expect(painted.startContainer.isConnected).toBe(true)
  })

  it('holds reports while an IME composes and reports once when it ends', () => {
    const { onState, root, probe } = mount()
    probe.act(() => root.dispatchEvent(new Event('compositionstart', { bubbles: true })))
    probe.act(() => type(root, 'に'))
    probe.act(() => type(root, 'ほ'))
    expect(onState).not.toHaveBeenCalled()
    probe.act(() => root.dispatchEvent(new Event('compositionend', { bubbles: true })))
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState.mock.lastCall?.[0]).toBe('にほ')
  })

  it('insertText through the handle types at the end and reports once', () => {
    const { onState, ref, root, probe } = mount()
    probe.act(() => type(root, 'a'))
    probe.act(() => ref.current!.insertText('bc'))
    expect(onState).toHaveBeenCalledTimes(2)
    expect(onState.mock.lastCall?.[0]).toBe('abc')
  })
})
