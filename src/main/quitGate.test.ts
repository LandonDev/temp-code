import { describe, expect, it, vi } from 'vitest'
import { QuitGate } from './quitGate'

describe('QuitGate', () => {
  it('opens once and closes on cancel', () => {
    const gate = new QuitGate(() => {})
    expect(gate.isQuitting()).toBe(false)
    expect(gate.begin()).toBe(true)
    expect(gate.begin()).toBe(false)
    expect(gate.isQuitting()).toBe(true)
    gate.cancel()
    expect(gate.isQuitting()).toBe(false)
    expect(gate.begin()).toBe(true)
  })

  it('ends a plain quit with the default finisher', () => {
    const quit = vi.fn()
    const gate = new QuitGate(quit)
    gate.finish()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('ends an armed quit with the armed finisher, once', () => {
    const quit = vi.fn()
    const install = vi.fn()
    const declined = vi.fn()
    const gate = new QuitGate(quit)
    gate.arm(install, declined)
    expect(gate.armed()).toBe(true)
    gate.finish()
    gate.finish()
    expect(install).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(declined).not.toHaveBeenCalled()
    expect(gate.armed()).toBe(false)
  })

  it('a declined dialog disarms and reports back', () => {
    const quit = vi.fn()
    const install = vi.fn()
    const declined = vi.fn()
    const gate = new QuitGate(quit)
    gate.arm(install, declined)
    gate.decline()
    expect(declined).toHaveBeenCalledTimes(1)
    expect(gate.armed()).toBe(false)
    gate.finish()
    expect(install).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledTimes(1)
    gate.decline()
    expect(declined).toHaveBeenCalledTimes(1)
  })

  it('cancel drops an armed finisher', () => {
    const install = vi.fn()
    const gate = new QuitGate(() => {})
    gate.begin()
    gate.arm(install, () => {})
    gate.cancel()
    expect(gate.armed()).toBe(false)
    gate.finish()
    expect(install).not.toHaveBeenCalled()
  })
})
