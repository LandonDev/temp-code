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
