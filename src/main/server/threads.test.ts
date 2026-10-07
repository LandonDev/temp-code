import { expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { threadPreamble } from './threads'

const session = (threadType: SessionMeta['threadType']): SessionMeta =>
  ({
    id: 'thread-1',
    provider: 'claude',
    model: 'claude-fable-5-1',
    threadType,
    planPath: '/tmp/plan.md',
    projectId: null,
    cwd: '/tmp/not-a-repo',
    permission: 'ask'
  }) as unknown as SessionMeta

it('a chat asks only for what it cannot find out, and one handoff question at most', () => {
  const text = threadPreamble(session('chat')) ?? ''
  expect(text).toContain('names no thread type, ask exactly one question — which thread type')
  expect(text).toContain('NEVER ask whether to start a thread')
  expect(text).toContain('seedThreadIds: ["thread-1"]')
  expect(text).not.toContain('liberally')
  expect(text).not.toContain('offer to start a planning thread')
  // The batching nudge is what made chats bolt a handoff onto a real question.
  expect(text).not.toContain('gathering every decision')
  expect(text).toContain('AskUserQuestion')
})

it('a planning thread still batches every ready decision into one call', () => {
  const text = threadPreamble(session('planning')) ?? ''
  expect(text).toContain('gathering every decision that is ready into one call')
})

it('a research thread synthesizes from files, never stops an explorer, and has a numeric done floor', () => {
  const text = threadPreamble(session('research')) ?? ''
  expect(text).toContain('at least 3 finished angles')
  expect(text).toContain('15 distinct cited sources')
  expect(text).toContain('file paths count as sources')
  expect(text).toContain('NEVER interrupt_agent an explorer')
  expect(text).toContain('SYNTHESIZE FROM THE FILES')
  expect(text).toContain('never name output paths yourself')
  expect(text).toContain('ONE Limits section')
  expect(text).toContain('call cite_source')
  expect(text).toContain('read the report and the findings files first')
  // Research is web, codebase, or both — the web-only framing is gone.
  expect(text).not.toContain('Your sources are the web')
  expect(text).not.toContain('not this codebase')
  expect(text).not.toContain('cannot fetch pages')
  const codex = threadPreamble({ ...session('research'), provider: 'codex' }) ?? ''
  expect(codex).toContain('cannot fetch pages')
  expect(codex).toContain('spawn claude explorers')
})

// ── project context: reports at the workspace root ─────────────────

it('the project context lists reports from the reports root by absolute path', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { projectContext } = await import('./threads')
  const root = await mkdtemp(join(tmpdir(), 'tc-ctx-'))
  try {
    const wsPath = join(root, 'repo')
    const dir = join(wsPath, '.temp-code', 'reports')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'r1.md'),
      '---\ntitle: Leagues v2\ndate: 2026-10-06\nstatus: complete\n---\n# Leagues\n'
    )
    const s = { ...session('implementation'), cwd: join(root, 'worktree') }
    const project = {
      id: 'p1',
      workspaceId: 'ws1',
      name: 'feature',
      mode: 'worktree' as const,
      branch: 'tc/feature',
      cwd: s.cwd,
      archived: false,
      createdAt: 1
    }
    const text = projectContext(s, project, 'repo', [], wsPath)
    expect(text).toContain(`"Leagues v2" (2026-10-06, complete) — ${join(dir, 'r1.md')}`)
    expect(text).toContain(`- ${dir}/ — research reports`)
    // Without a reports root the cwd is searched, and this one has none.
    expect(projectContext(s, project, 'repo', [])).not.toContain('research reports')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
