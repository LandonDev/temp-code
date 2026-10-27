// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readTextFile = vi.fn((_environmentId: string, _path: string) => Promise.resolve('a\nb\nc\n'))
vi.mock('../lib/fs', () => ({ readTextFile: (environmentId: string, path: string) => readTextFile(environmentId, path) }))
vi.mock('./monaco/InlineEditor', () => ({ default: () => <div data-testid="inline-editor" /> }))

import { EditRow } from './EditRow'
import { diffChunk } from './chunks'
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
    expect(getByText('Edited').className).toContain('text-muted-foreground')
    expect(getByText('a.ts')).toBeTruthy()
    expect(getByText('+1').className).toContain('text-success')
    expect(getByText('−1').className).toContain('text-destructive')
    expect(container.querySelector('.border')).toBeNull()
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
