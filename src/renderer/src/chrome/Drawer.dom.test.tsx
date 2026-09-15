import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountProbe } from '../test/renderProbe'
import { DRAWER_CLOSE_MS, Drawer } from './Drawer'

let root: HTMLElement
const body = () => root.querySelector('[data-body]') as HTMLElement | null
const tab = () => root.querySelector('[data-tab]') as HTMLElement | null
const shell = () => root.firstElementChild as HTMLElement

function ui(open: boolean, extra: Partial<Parameters<typeof Drawer>[0]> = {}) {
  return (
    <Drawer open={open} width={300} closedWidth={32} closed={<button data-tab>tab</button>} {...extra}>
      <p data-body>body</p>
    </Drawer>
  )
}

describe('Drawer', () => {
  let probe: ReturnType<typeof mountProbe>
  const mount = (el: Parameters<typeof mountProbe>[0]) => {
    probe = mountProbe(el)
    root = probe.container
    return probe
  }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    probe.unmount()
    vi.useRealTimers()
  })

  it('opens: mounts the body at its final width and drops the tab', () => {
    mount(ui(false))
    expect(body()).toBeNull()
    expect(tab()).not.toBeNull()
    expect(shell().style.width).toBe('32px')

    probe.act(() => probe.rerender(ui(true)))
    expect(tab()).toBeNull()
    expect(body()!.parentElement!.style.width).toBe('300px')
    expect(body()!.parentElement!.style.opacity).toBe('1')
    expect(shell().style.width).toBe('300px')
  })

  it('closes: keeps the body inert while the tween plays, then unmounts it', () => {
    mount(ui(true))
    const node = shell()
    probe.act(() => probe.rerender(ui(false)))
    expect(shell()).toBe(node)
    expect(shell().style.width).toBe('32px')
    expect(body()).not.toBeNull()
    expect(body()!.parentElement!.hasAttribute('inert')).toBe(true)
    expect(body()!.parentElement!.style.opacity).toBe('0')
    expect(tab()).not.toBeNull()

    probe.act(() => { vi.advanceTimersByTime(DRAWER_CLOSE_MS + 1) })
    expect(body()).toBeNull()
    expect(tab()).not.toBeNull()
  })

  it('a reopen mid-close cancels the unmount', () => {
    mount(ui(true))
    probe.act(() => probe.rerender(ui(false)))
    probe.act(() => { vi.advanceTimersByTime(DRAWER_CLOSE_MS / 2) })
    probe.act(() => probe.rerender(ui(true)))
    probe.act(() => { vi.advanceTimersByTime(DRAWER_CLOSE_MS * 2) })
    expect(body()).not.toBeNull()
    expect(body()!.parentElement!.hasAttribute('inert')).toBe(false)
    expect(tab()).toBeNull()
  })

  it('keepMounted parks the body invisible and inert once closed', () => {
    mount(ui(true, { keepMounted: true }))
    probe.act(() => probe.rerender(ui(false, { keepMounted: true })))
    probe.act(() => { vi.advanceTimersByTime(DRAWER_CLOSE_MS + 1) })
    expect(body()).not.toBeNull()
    expect(body()!.parentElement!.className).toContain('invisible')
    expect(body()!.parentElement!.hasAttribute('inert')).toBe(true)
  })

  it('renders nothing when closed with no tab and no closed width', () => {
    mount(
      <Drawer open={false} width={300}>
        <p data-body>body</p>
      </Drawer>,
    )
    expect(root.firstElementChild).toBeNull()
  })
})
