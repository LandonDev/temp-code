import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newTerminalFile } from '../lib/layout'
import { DEV_TAB, DockBar, type DockBarProps } from './DockBar'

const a = { ...newTerminalFile('/repo', 'zsh'), id: 'a' }
const b = { ...newTerminalFile('/repo/web', 'build'), id: 'b' }

function mount(over: Partial<DockBarProps> = {}) {
  const props: DockBarProps = {
    terminals: [a, b],
    active: 'a',
    dev: { count: 0 },
    onSelect: vi.fn(),
    onSelectDev: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onAdd: vi.fn(),
    onHide: vi.fn(),
    ...over
  }
  const view = render(<DockBar {...props} />)
  const tabs = () => [...view.container.querySelectorAll('[role="tab"]')] as HTMLElement[]
  const tab = (name: string) => tabs().find((t) => t.textContent?.startsWith(name))!
  return { props, view, tabs, tab }
}

afterEach(cleanup)

describe('DockBar', () => {
  it('renders the terminals and the Dev servers tab as one line of tabs', () => {
    const { view, tabs, tab } = mount()
    expect(view.container.querySelector('[data-slot="tabs-list"]')?.getAttribute('data-variant')).toBe('line')
    expect(tabs().map((t) => t.textContent)).toEqual(['zsh', 'build', 'Dev servers'])
    expect(tab('zsh').getAttribute('aria-selected')).toBe('true')
  })

  it('shows the count only above zero', () => {
    expect(mount({ dev: { count: 0 } }).tab('Dev servers').textContent).toBe('Dev servers')
    cleanup()
    expect(mount({ dev: { count: 2 } }).tab('Dev servers').textContent).toBe('Dev servers2')
  })

  it('has no Dev servers tab when dev is null', () => {
    expect(mount({ dev: null }).tabs().map((t) => t.textContent)).toEqual(['zsh', 'build'])
  })

  it('routes a terminal pick to onSelect and the Dev servers tab to onSelectDev', () => {
    const { props, tab } = mount()
    fireEvent.click(tab('build'))
    expect(props.onSelect).toHaveBeenCalledWith('b')
    fireEvent.click(tab('Dev servers'))
    expect(props.onSelectDev).toHaveBeenCalledTimes(1)
  })

  it('marks the Dev servers tab when it is the one showing', () => {
    expect(mount({ active: DEV_TAB }).tab('Dev servers').getAttribute('aria-selected')).toBe('true')
  })

  it('closes a terminal from its X and on a middle click', () => {
    const { props, view, tab } = mount()
    fireEvent.click(view.getByLabelText('Close build'))
    expect(props.onClose).toHaveBeenCalledWith('b')
    fireEvent(tab('zsh').closest('[data-dock-tab]')!, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(props.onClose).toHaveBeenCalledWith('a')
  })

  it('has no close without onClose', () => {
    const onSelect = vi.fn()
    const { view, tab } = mount({ onClose: undefined, onSelect })
    expect(view.queryByLabelText('Close zsh')).toBeNull()
    fireEvent(tab('zsh').closest('[data-dock-tab]')!, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(3)
  })

  it('calls onAdd and onHide from the buttons at the end', () => {
    const { props, view } = mount()
    fireEvent.click(view.getByLabelText('New terminal'))
    fireEvent.click(view.getByLabelText('Hide panel'))
    expect(props.onAdd).toHaveBeenCalledTimes(1)
    expect(props.onHide).toHaveBeenCalledTimes(1)
  })
})
