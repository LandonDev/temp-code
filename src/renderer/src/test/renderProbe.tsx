/**
 * Render-count probe for the `dom` vitest project.
 *
 *   const probe = mountProbe(<Probe id="input"><ComposerInput … /></Probe>)
 *   probe.act(() => { … })
 *   expect(probe.renders('input')).toBe(1)
 *
 * `renders(id)` is the number of React commits in which the subtree under
 * `<Probe id>` did work — what `<Profiler onRender>` reports. It counts
 * commits, not layout or paint: a green count says React left the subtree
 * alone, nothing more.
 */
import { Profiler, type ReactElement, type ReactNode } from 'react'
import { act, render } from '@testing-library/react'

const tallies = new Map<string, number>()

export function Probe({ id, children }: { id: string; children: ReactNode }): ReactElement {
  return (
    <Profiler id={id} onRender={() => tallies.set(id, (tallies.get(id) ?? 0) + 1)}>
      {children}
    </Profiler>
  )
}

export interface RenderProbe {
  /** commits in which the subtree under `<Probe id>` rendered */
  renders: (id: string) => number
  rerender: (ui: ReactElement) => void
  unmount: () => void
  act: typeof act
  container: HTMLElement
}

/** Mount inside `act` and start every tally from zero. */
export function mountProbe(ui: ReactElement): RenderProbe {
  tallies.clear()
  const mounted = render(ui)
  return {
    renders: (id) => tallies.get(id) ?? 0,
    rerender: (next) => mounted.rerender(next),
    unmount: () => mounted.unmount(),
    act,
    container: mounted.container
  }
}
