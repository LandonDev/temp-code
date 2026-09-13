// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ComposerInput } from './ComposerInput'
import { devRenders } from '../lib/devRenders'
import { mountProbe, Probe } from '../test/renderProbe'

/**
 * The Slice 0 proof of the dom harness: the input is uncontrolled, so
 * keystrokes report through `onState` and never re-render the component.
 */
describe('ComposerInput under jsdom', () => {
  function mount() {
    const onState = vi.fn()
    const probe = mountProbe(
      <Probe id="input">
        <ComposerInput
          onState={onState}
          onKeyDown={() => {}}
          onPaste={() => {}}
          placeholder="Ask"
          maxHeight={160}
        />
      </Probe>
    )
    const root = probe.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    return { onState, probe, root }
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
    for (let i = 0; i < 20; i++) {
      probe.act(() => {
        root.append(document.createTextNode('a'))
        root.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
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
})
