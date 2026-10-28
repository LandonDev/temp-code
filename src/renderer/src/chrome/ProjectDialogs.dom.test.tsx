import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { registry, LOCAL_ENVIRONMENT_ID } from '../lib/connection/registry'
import { IDLE_STATUS, type EnvironmentStatus } from '../lib/connection/types'
import type { Link } from '../lib/connection'
import { workspaceStore } from '../lib/tcserver/workspaces'
import type { ProjectMeta, WorkspaceMeta } from '../lib/tcserver/types'
import { NewProjectDialog, ProjectSettingsDialog, ProjectTeardownDialog } from './ProjectDialogs'
import { PreambleDialog } from './PreambleDialog'
import { resetPlanSettingsForTests } from '../lib/tcserver/plans'

// jsdom has no Web Animations; the settings sheet's scroll area asks for them.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []

// Two hosts: this Mac (the `local` slot, host id env_mac, darwin) and the
// box (env_box, linux). One project linked across both, one only on the Mac.
const BOX = 'env_box'

const ws = (environmentId: string, id: string, path: string): WorkspaceMeta => ({
  id,
  name: 'temp-code',
  path,
  git: true,
  linkId: 'wl_1',
  createdAt: 1,
  environmentId
})

const project = (environmentId: string, over: Partial<ProjectMeta>): ProjectMeta => ({
  id: 'p',
  workspaceId: 'w',
  name: 'Alpha',
  mode: 'local',
  branch: null,
  cwd: '/x',
  archived: false,
  createdAt: 1,
  environmentId,
  ...over
})

const MAC_WS = ws(LOCAL_ENVIRONMENT_ID, 'w_mac', '/Users/l/IdeaProjects/temp-code')
const BOX_WS = ws(BOX, 'w_box', '/srv/agents/work/temp-code')
// The Mac's copy still has the old name and preamble: its pull lags the box.
const MAC = project(LOCAL_ENVIRONMENT_ID, {
  id: 'p_mac',
  workspaceId: 'w_mac',
  name: 'Alpha (stale)',
  preamble: 'old rules',
  cwd: MAC_WS.path,
  linkId: 'pl_1'
})
const BOX_COPY = project(BOX, {
  id: 'p_box',
  workspaceId: 'w_box',
  name: 'Alpha',
  preamble: 'box rules',
  cwd: BOX_WS.path,
  linkId: 'pl_1'
})
const SOLO = project(LOCAL_ENVIRONMENT_ID, { id: 'p_solo', workspaceId: 'w_mac', name: 'Solo', cwd: MAC_WS.path })

type Call = { slot: string; method: string; params: Record<string, unknown> }
let calls: Call[] = []
let boxOpen = true
// A project-scope plans.get that fails for good (the global one still answers).
let projectPlansFail = false

const status = (slot: string): EnvironmentStatus => {
  const box = slot === BOX
  return {
    ...IDLE_STATUS,
    transport: box && !boxOpen ? 'offline' : 'open',
    lastHello: {
      environmentId: box ? BOX : 'env_mac',
      contract: 1,
      caps: [],
      build: { release: 1, version: '1.0.1', sha: null, platform: box ? 'linux' : 'darwin' }
    }
  }
}

const linkFor = (slot: string): Link =>
  ({
    environmentId: slot,
    connected: true,
    onOpen: () => () => {},
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ slot, method, params })
      if (projectPlansFail && method === 'plans.get' && params.projectId) throw new Error('not connected')
      return null
    }
  }) as unknown as Link

const writes = () => calls.filter((c) => !/\.(get|detect|list)$/.test(c.method) && c.method !== 'accounts.list')

beforeEach(() => {
  calls = []
  boxOpen = true
  projectPlansFail = false
  resetPlanSettingsForTests()
  workspaceStore.reset()
  workspaceStore.hydrate([
    { environmentId: LOCAL_ENVIRONMENT_ID, workspaces: [MAC_WS], projects: [MAC, SOLO] },
    { environmentId: BOX, workspaces: [BOX_WS], projects: [BOX_COPY] }
  ])
  vi.spyOn(registry, 'statusOf').mockImplementation(status)
  vi.spyOn(registry, 'environment').mockImplementation((id: string) =>
    id === BOX ? { id, name: 'box', routes: [], credentialRef: id } : undefined
  )
  vi.spyOn(registry, 'linkOf').mockImplementation((slot: string) => linkFor(slot) as never)
  vi.spyOn(workspaceStore, 'refresh').mockResolvedValue()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  workspaceStore.reset()
})

// A closed modal leaves an inert fading copy behind for a moment; read the live one.
const footerNote = () =>
  [...document.body.querySelectorAll('[data-footer-note]')].find((n) => !n.closest('[inert]'))?.textContent ?? null
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

describe('ProjectSettingsDialog on a linked project', () => {
  it('reads from the box copy, says where it saves, and saves the name there', async () => {
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    const name = screen.getByDisplayValue('Alpha') as HTMLInputElement
    expect(footerNote()).toBe('Saved on box')
    await waitFor(() => expect(calls.some((c) => c.method === 'build.get')).toBe(true))
    const reads = calls.filter((c) => c.method.endsWith('.get'))
    expect(reads.every((c) => c.slot === BOX)).toBe(true)
    expect(calls.find((c) => c.method === 'build.get')?.params).toMatchObject({ workspaceId: 'w_box', projectId: 'p_box' })

    fireEvent.change(name, { target: { value: 'Alpha two' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({ slot: BOX, method: 'project.rename', params: { projectId: 'p_box', name: 'Alpha two' } })
  })

  it('disables Save with the reason while the box is offline', () => {
    boxOpen = false
    render(<ProjectSettingsDialog project={MAC} workspace={MAC_WS} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Alpha two' } })
    expect(saveButton().disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })

  it('an unlinked project reads and saves on its own host, with no footer note', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    expect(footerNote()).toBeNull()
    fireEvent.change(screen.getByDisplayValue('Solo'), { target: { value: 'Solo two' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toMatchObject({ slot: LOCAL_ENVIRONMENT_ID, method: 'project.rename', params: { projectId: 'p_solo' } })
    expect(calls.every((c) => c.slot === LOCAL_ENVIRONMENT_ID)).toBe(true)
  })
})

describe('PreambleDialog on a linked project', () => {
  it('edits the box copy’s text and saves it there', async () => {
    render(<PreambleDialog scope={{ kind: 'project', project: MAC, workspace: MAC_WS }} onClose={() => {}} />)
    const text = screen.getByDisplayValue('box rules') as HTMLTextAreaElement
    expect(footerNote()).toBe('Saved on box')
    fireEvent.change(text, { target: { value: 'new rules' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      slot: BOX,
      method: 'project.setPreamble',
      params: { projectId: 'p_box', preamble: 'new rules', enabled: true }
    })
  })

  it('disables Save with the reason while the box is offline', () => {
    boxOpen = false
    render(<PreambleDialog scope={{ kind: 'project', project: MAC, workspace: MAC_WS }} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('box rules'), { target: { value: 'new rules' } })
    expect(saveButton().disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })
})

describe('ProjectSettingsDialog as a sheet', () => {
  it('slides in from the right with the name focused and every section open, no folds', async () => {
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    const sheet = screen.getByRole('dialog')
    expect(sheet.getAttribute('data-side')).toBe('right')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')))
    const headings = [...sheet.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings).toEqual(['Completed turn', 'Reviews', 'Accounts', 'Plans', 'Build'])
    expect(sheet.querySelector('[aria-expanded]:not([data-slot=select-trigger])')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use workspace setting' })).toBeNull()
  })
})

describe('ProjectSettingsDialog when the project\'s plans fail to load', () => {
  it('says why with Retry instead of fields from the global set that would never save', async () => {
    projectPlansFail = true
    render(<ProjectSettingsDialog project={SOLO} workspace={MAC_WS} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('not connected')).toBeTruthy())
    expect(screen.queryByRole('switch', { name: 'Auto-start' })).toBeNull()
    projectPlansFail = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Auto-start' })).toBeTruthy())
  })
})

describe('ProjectTeardownDialog on a linked project', () => {
  it('archive archives every copy, the box first', async () => {
    const done = vi.fn()
    render(<ProjectTeardownDialog project={MAC} action="archive" onClose={() => {}} onDone={done} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [BOX, 'project.archive', 'p_box'],
      [LOCAL_ENVIRONMENT_ID, 'project.archive', 'p_mac']
    ])
  })

  it('archive is held with the reason while the box is offline', () => {
    boxOpen = false
    render(<ProjectTeardownDialog project={MAC} action="archive" onClose={() => {}} onDone={() => {}} />)
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true)
    expect(footerNote()).toBe('box is offline')
  })

  it('delete takes this copy only, unless the copy on the box is ticked', async () => {
    const done = vi.fn()
    const first = render(<ProjectTeardownDialog project={MAC} action="delete" onClose={() => {}} onDone={done} />)
    // A choice to make: a form dialog, never a confirm holding a checkbox.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('Delete Alpha (stale)?')
    expect(screen.getByRole('dialog').textContent).toContain('Its threads are deleted for good.')
    expect(screen.getByRole('button', { name: 'Delete project' }).getAttribute('data-variant')).toBe('destructive')
    const also = screen.getByRole('checkbox', { name: 'Also delete the copy on box' })
    expect(also.getAttribute('aria-checked')).toBe('false')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [LOCAL_ENVIRONMENT_ID, 'project.delete', 'p_mac']
    ])
    first.unmount()

    calls = []
    render(<ProjectTeardownDialog project={MAC} action="delete" onClose={() => {}} onDone={done} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete the copy on box' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    })
    await waitFor(() => expect(done).toHaveBeenCalledTimes(2))
    expect(writes().map((c) => [c.slot, c.method, c.params.projectId])).toEqual([
      [LOCAL_ENVIRONMENT_ID, 'project.delete', 'p_mac'],
      [BOX, 'project.delete', 'p_box']
    ])
  })

  it('an unlinked project with nothing to clean up is a plain confirm', () => {
    render(<ProjectTeardownDialog project={SOLO} action="delete" onClose={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(footerNote()).toBeNull()
  })
})

describe('NewProjectDialog', () => {
  it('focuses the name, picks the mode from the toggle, and creates once the exit has played', async () => {
    const created = vi.fn()
    render(<NewProjectDialog workspace={MAC_WS} onClose={() => {}} onCreated={created} />)
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    const worktree = screen.getByRole('button', { name: 'Worktree' })
    const local = screen.getByRole('button', { name: 'Local' })
    expect(worktree.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Branch')).toBeTruthy()
    expect(screen.getByText('Own branch and folder, isolated from your checkout.')).toBeTruthy()

    fireEvent.click(local)
    expect(local.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('Branch')).toBeNull()
    // Pressing the chosen mode again keeps it: a mode is never unset.
    fireEvent.click(local)
    expect(local.getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(name, { target: { value: 'Search' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    })
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
    expect(writes().find((c) => c.method === 'project.create')?.params).toEqual({ workspaceId: 'w_mac', name: 'Search', mode: 'local' })
  })
})
