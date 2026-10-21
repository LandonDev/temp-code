import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_REVIEW_SETTINGS } from '@shared/review'
import { openDb, Store } from './db'
import { setOrchestrationRegistry } from './orchestration'
import { SessionRegistry } from './sessions'
import { threadPreamble } from './threads'

/** The implementation preamble names merge_branch only in a reviewed project. */
let root: string
let db: ReturnType<typeof openDb>
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-threads-review-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
  setOrchestrationRegistry(registry)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('tells a thread of a reviewed project to merge through merge_branch, and says nothing otherwise', async () => {
  const ws = await registry.createWorkspace(root, 'w')
  const project = await registry.createProject(ws.id, 'p', 'local')
  const other = await registry.createProject(ws.id, 'q', 'local')
  const thread = await registry.create({ projectId: project.id, threadType: 'implementation', provider: 'claude' })
  const elsewhere = await registry.create({ projectId: other.id, threadType: 'implementation', provider: 'claude' })

  expect(threadPreamble(thread)).not.toContain('merge_branch')

  registry.setReviewSettings(null, { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: true })
  expect(threadPreamble(thread)).toContain('land your branch by calling the merge_branch app tool')
  expect(threadPreamble(thread)).toContain('NEVER run git merge, git push')
  // The project override wins over the global set, whole.
  registry.setReviewSettings(other.id, { ...DEFAULT_REVIEW_SETTINGS, beforeMerge: false })
  expect(threadPreamble(elsewhere)).not.toContain('merge_branch')
  expect(registry.effectiveReview(other.id)).toMatchObject({ source: 'project', settings: { beforeMerge: false } })
  expect(registry.effectiveReview(project.id)).toMatchObject({ source: 'global', settings: { beforeMerge: true } })
  registry.setReviewSettings(other.id, null)
  expect(registry.effectiveReview(other.id).source).toBe('global')

  // A chat thread never merges: no note, whatever the set says.
  const chat = await registry.create({ projectId: project.id, threadType: 'chat', provider: 'claude' })
  expect(threadPreamble(chat)).not.toContain('merge_branch')
})
