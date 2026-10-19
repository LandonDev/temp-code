// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readTextFile = vi.fn((_environmentId: string, _path: string) => Promise.resolve('a\nb\nc\n'))
vi.mock('../lib/fs', () => ({ readTextFile: (environmentId: string, path: string) => readTextFile(environmentId, path) }))

import { EditRow } from './EditRow'
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

afterEach(() => {
  readTextFile.mockClear()
})

describe('EditRow', () => {
  it('a collapsed row never reads its file; opening the diff does, once', async () => {
    const { container, getByLabelText } = render(<EditRow block={edit} cwd="/repo" />)
    await act(async () => {})
    expect(readTextFile).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('B')
    await act(async () => {
      fireEvent.click(getByLabelText('Show diff'))
    })
    expect(readTextFile).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('B')
    expect(readTextFile).toHaveBeenCalledWith('local', '/repo/a.ts')
    await act(async () => {
      fireEvent.click(getByLabelText('Hide diff'))
    })
    await act(async () => {
      fireEvent.click(getByLabelText('Show diff'))
    })
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })
})

vi.mock('../lib/tcserver/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tcserver/projects')>()),
  hostOfCwd: () => 'local',
}))
