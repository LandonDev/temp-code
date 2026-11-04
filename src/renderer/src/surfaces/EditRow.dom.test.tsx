// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readTextFile = vi.fn((_environmentId: string, _path: string) => Promise.resolve('a\nb\nc\n'))
vi.mock('../lib/fs', () => ({ readTextFile: (environmentId: string, path: string) => readTextFile(environmentId, path) }))
vi.mock('./monaco/InlineEditor', () => ({ default: () => <div data-testid="inline-editor" /> }))

import { EditRow } from './EditRow'
import { diffChunk } from './chunks'
import { BODY_FRAME } from './transcript/ActionRow'
import { GroupHandContext } from './transcript/groupHand'
import type { Block } from '../lib/session'

const edit: Block = {
  id: 't1',
  role: 'tool',
  text: 'Edit a.ts',
  tool: {
    callId: 'c1',
    name: 'Edit',
    kind: 'edit',
    status: 'completed',
    input: { file_path: '/repo/a.ts', old_string: 'b', new_string: 'B' }
  }
}

const withTool = (block: Block, tool: Partial<NonNullable<Block['tool']>>, id = block.id): Block => ({
  ...block,
  id,
  tool: { ...block.tool!, callId: id, ...tool }
})

afterEach(() => {
  cleanup()
  readTextFile.mockClear()
})

describe('EditRow', () => {
  it('reads as one line: the verb, the file, its counts', () => {
    const { getByText, container } = render(<EditRow block={edit} cwd="/repo" />)
    // The verb's colour sits on its MorphText box.
    expect(getByText('Edited').closest('[data-slot=morph-text]')!.className).toContain('text-muted-foreground')
    expect(getByText('a.ts')).toBeTruthy()
    expect(getByText('+1').className).toContain('text-success')
    expect(getByText('−1').className).toContain('text-destructive')
    expect(getByText('+1').closest('[data-slot="counts"]')).not.toBeNull()
    expect(container.querySelector('.border')).toBeNull()
  })

  // First in the file: the diff chunk has not loaded yet, so its wait shows.
  it('while the diff chunk loads, the card holds one 20px skeleton line per row to show', () => {
    const { container, getByRole } = render(<EditRow block={withTool(edit, {}, 'sk1')} cwd="/repo" />)
    act(() => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
    })
    const skeleton = container.querySelector<HTMLElement>('[data-surface-skeleton]')
    expect(skeleton?.getAttribute('data-surface-skeleton')).toBe('diff-rows')
    expect(skeleton?.closest('[data-row-body]')).not.toBeNull()
    expect(skeleton?.querySelectorAll('[data-skeleton-row]')).toHaveLength(2)
  })

  it('a lone edit opens its diff in the row body card, the tints running to its edges', async () => {
    const { container, getByRole } = render(<EditRow block={withTool(edit, {}, 'fr1')} cwd="/repo" />)
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
      await diffChunk.load()
    })
    const add = container.querySelector<HTMLElement>('[data-diff-line="add"]')!
    const frame = add.closest<HTMLElement>('[data-row-body]')!
    expect(frame).not.toBeNull()
    for (const c of BODY_FRAME.split(' ')) expect(frame.className.split(' ')).toContain(c)
    // No side padding on the card; each line pads itself, so its tint meets the hairline.
    expect(frame.className.split(' ')).toEqual(expect.arrayContaining(['px-0', 'py-1']))
    expect(add.className.split(' ')).toContain('px-3')
    // 12px mono on 20px lines, the code ladder of a row's body.
    const code = add.lastElementChild as HTMLElement
    expect(code.className.split(' ')).toEqual(expect.arrayContaining(['font-mono', 'text-xs', 'leading-5']))
  })

  it('opening its diff inside a group tells the group a hand took it; closing does not', async () => {
    const hand = vi.fn()
    const { getByRole } = render(
      <GroupHandContext.Provider value={hand}>
        <EditRow block={withTool(edit, {}, 'gh1')} cwd="/repo" />
      </GroupHandContext.Provider>
    )
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
      await diffChunk.load()
    })
    expect(hand).toHaveBeenCalledTimes(1)
    act(() => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
    })
    expect(hand).toHaveBeenCalledTimes(1)
  })

  it('inside a card the edit draws no second frame', async () => {
    const { container, getByRole } = render(
      <div className="bg-card">
        <EditRow block={withTool(edit, {}, 'fr2')} cwd="/repo" />
      </div>
    )
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
      await diffChunk.load()
    })
    const frame = container.querySelector<HTMLElement>('[data-row-body]')!
    for (const c of ['in-[.bg-card]:border-0', 'in-[.bg-card]:bg-transparent', 'in-[.bg-card]:p-0', 'in-[.bg-card]:rounded-none'])
      expect(frame.className).toContain(c)
    expect(frame.querySelectorAll('[data-row-body]')).toHaveLength(0)
  })

  it('a collapsed row never reads its file; opening the diff does, once', async () => {
    const { container, getByRole } = render(<EditRow block={edit} cwd="/repo" />)
    const line = getByRole('button', { name: 'Edited a.ts' })
    await act(async () => {})
    expect(readTextFile).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('B')
    await act(async () => {
      fireEvent.click(line)
    })
    expect(line.getAttribute('aria-expanded')).toBe('true')
    expect(readTextFile).toHaveBeenCalledTimes(1)
    // The diff body rides the diff chunk (surfaces/chunks.ts): the rows land once it has.
    await act(async () => {
      await diffChunk.load()
    })
    expect(container.textContent).toContain('B')
    expect(readTextFile).toHaveBeenCalledWith('local', '/repo/a.ts')
    await act(async () => {
      fireEvent.click(line)
    })
    await act(async () => {
      fireEvent.click(line)
    })
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })

  it('a running edit stays closed when it settles', async () => {
    const running = withTool(edit, { status: 'running' }, 'run1')
    const { getByRole, rerender, container } = render(<EditRow block={running} cwd="/repo" />)
    expect(getByRole('button', { name: 'Editing a.ts' }).getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull()
    await act(async () => {
      rerender(<EditRow block={withTool(running, { status: 'completed' }, 'run1')} cwd="/repo" />)
    })
    expect(getByRole('button', { name: 'Edited a.ts' }).getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('B')
  })

  it('Edit here swaps in the editor and Show diff swaps back', async () => {
    const { getByRole, findByTestId, queryByTestId } = render(<EditRow block={withTool(edit, {}, 'ed1')} cwd="/repo" />)
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Edited a.ts' }))
    })
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Edit here' }))
    })
    expect(await findByTestId('inline-editor')).toBeTruthy()
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Show diff' }))
    })
    expect(queryByTestId('inline-editor')).toBeNull()
  })

  it('a created file says Created', () => {
    const write: Block = withTool(edit, { name: 'Write', kind: 'write', input: { file_path: '/repo/diag.ts', content: 'x\ny' } }, 'w1')
    const { getByText } = render(<EditRow block={write} cwd="/repo" />)
    expect(getByText('Created')).toBeTruthy()
    expect(getByText('diag.ts')).toBeTruthy()
    expect(getByText('+2')).toBeTruthy()
  })

  it('a failed edit shows the failed glyph, not a red name', () => {
    const { getByLabelText, getByText } = render(<EditRow block={withTool(edit, { status: 'failed' }, 'f1')} cwd="/repo" />)
    expect(getByLabelText('Failed').getAttribute('class')).toContain('text-destructive')
    expect(getByText('a.ts').className).not.toContain('destructive')
  })

  it('the name opens the file', () => {
    const onOpenFile = vi.fn()
    const { getByRole } = render(<EditRow block={edit} cwd="/repo" onOpenFile={onOpenFile} />)
    fireEvent.click(getByRole('button', { name: 'Open a.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('/repo/a.ts', undefined, { environmentId: 'local' })
  })
})

vi.mock('../lib/tcserver/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tcserver/projects')>()),
  hostOfCwd: () => 'local',
}))
