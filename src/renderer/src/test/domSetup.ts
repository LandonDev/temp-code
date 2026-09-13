/**
 * What jsdom lacks and the renderer uses unguarded. Loaded as the `dom`
 * project's setup file (vitest.config.ts), so every *.dom.test.tsx gets it.
 *
 * None of these do anything: `matchMedia` never matches, observers never
 * fire, `animate` finishes at once, highlights are a plain Map. A test
 * that needs one of them to behave must drive it itself — this file only
 * keeps a mount from throwing.
 */

type Listener = (event: Event) => void

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }) as MediaQueryList
}

if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate(): Animation {
    const listeners = new Map<string, Set<Listener>>()
    const anim = {
      playState: 'finished',
      currentTime: 0,
      playbackRate: 1,
      onfinish: null as Listener | null,
      oncancel: null as Listener | null,
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      play: () => {},
      pause: () => {},
      cancel: () => {},
      finish: () => {},
      reverse: () => {},
      commitStyles: () => {},
      persist: () => {},
      updatePlaybackRate: () => {},
      addEventListener: (type: string, fn: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
      },
      removeEventListener: (type: string, fn: Listener) => {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent: () => false
    }
    return anim as unknown as Animation
  }
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return []
  }
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver
}
if (typeof globalThis.IntersectionObserver !== 'function') {
  globalThis.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver
}

// CSS.highlights: the composer paints `/skill` and `@file` runs through it.
// A Map keyed by name is enough for tests to see what would be painted.
if (typeof globalThis.Highlight !== 'function') {
  class Highlight {
    readonly ranges: Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }
  globalThis.Highlight = Highlight as unknown as typeof globalThis.Highlight
}
const css = (globalThis.CSS ?? (globalThis.CSS = {} as typeof CSS)) as unknown as {
  highlights?: Map<string, Highlight>
}
if (!css.highlights) css.highlights = new Map()
