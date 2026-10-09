import type { ExecFileException } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveBinary: vi.fn(),
  harnessEnv: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./drivers/binaries', () => ({
  resolveBinary: mocks.resolveBinary,
  harnessEnv: mocks.harnessEnv
}))

interface Fixture {
  program?: string
  args: string[]
  stdout?: string
  stderr?: string
  error?: ExecFileException
  inspect?: (args: string[], options: Record<string, unknown>) => void
}

type ExecCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void

let fixtures: Fixture[]
let shellPath: string
let github: typeof import('./github')

function failure(message = 'command failed', code: string | number = 1): ExecFileException {
  return Object.assign(new Error(message), { code })
}

function queue(...items: Fixture[]): void {
  fixtures.push(...items)
}

beforeEach(async () => {
  vi.resetModules()
  fixtures = []
  shellPath = '/interactive/bin:/usr/bin:/bin'
  mocks.execFile.mockReset()
  mocks.resolveBinary.mockReset().mockResolvedValue('/mock/gh')
  mocks.harnessEnv.mockReset().mockResolvedValue({ PATH: '/login/bin:/usr/bin' })
  mocks.execFile.mockImplementation(
    (
      program: string,
      args: string[],
      options: Record<string, unknown>,
      callback: ExecCallback
    ) => {
      if (args[0] === '-lic' && args[1] === 'printenv PATH') {
        callback(null, shellPath, '')
        return undefined
      }
      const fixture = fixtures.shift()
      expect(fixture, `unexpected command: ${program} ${args.join(' ')}`).toBeDefined()
      if (!fixture) return undefined
      expect(program).toBe(fixture.program ?? '/mock/gh')
      expect(args).toEqual(fixture.args)
      fixture.inspect?.(args, options)
      callback(fixture.error ?? null, fixture.stdout ?? '', fixture.stderr ?? '')
      return undefined
    }
  )
  github = await import('./github')
})

afterEach(() => {
  expect(fixtures).toEqual([])
})

describe('GitHub gh bridge', () => {
  it('resolves the repo slug with donor args and expands a home cwd', async () => {
    queue({
      args: ['repo', 'view', '--json', 'nameWithOwner'],
      stdout: '{"nameWithOwner":" acme/web "}',
      inspect: (_args, options) => {
        expect(options.cwd).toBe(process.env.HOME)
        expect(options.env).toMatchObject({
          PATH: expect.stringContaining('/interactive/bin'),
          GIT_TERMINAL_PROMPT: '0',
          GH_PAGER: 'cat',
          GIT_PAGER: 'cat'
        })
      }
    })

    await expect(github.githubRepo('~')).resolves.toBe('acme/web')
  })

  it('maps gh stderr, stdout, empty output, and ENOENT errors', async () => {
    const args = ['repo', 'view', '--json', 'nameWithOwner']
    queue(
      { args, error: failure(), stderr: 'auth required\n' },
      { args, error: failure(), stdout: 'request failed\n' },
      { args, stdout: '   ' },
      { args, error: failure('spawn gh ENOENT', 'ENOENT') }
    )

    await expect(github.githubRepo('/repo')).rejects.toThrow('auth required')
    await expect(github.githubRepo('/repo')).rejects.toThrow('request failed')
    await expect(github.githubRepo('/repo')).rejects.toThrow('gh returned no output')
    await expect(github.githubRepo('/repo')).rejects.toThrow(
      'GitHub CLI (`gh`) is not installed.'
    )
  })

  it('reads the gh token once, forgets it on demand, and classifies failures', async () => {
    queue({ args: ['auth', 'token'], stdout: 'gho_secret\n' })
    await expect(github.ghAuthToken()).resolves.toBe('gho_secret')
    await expect(github.ghAuthToken()).resolves.toBe('gho_secret') // cached: no second spawn

    github.forgetGhToken()
    queue({ args: ['auth', 'token'], error: failure(), stderr: 'not logged in\n' })
    await expect(github.ghAuthToken()).rejects.toMatchObject({ state: 'logged-out' })
    queue({ args: ['auth', 'token'], stdout: '\n' })
    await expect(github.ghAuthToken()).rejects.toMatchObject({ state: 'logged-out' })
    queue({ args: ['auth', 'token'], error: failure('spawn gh ENOENT', 'ENOENT') })
    await expect(github.ghAuthToken()).rejects.toMatchObject({ state: 'missing-gh' })

    queue({ args: ['auth', 'token'], stdout: 'gho_again' })
    await expect(github.ghAuthToken()).resolves.toBe('gho_again') // a failure is not cached
  })

  it('finds gh on the cached interactive-shell PATH when resolveBinary misses it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'temp-code-gh-test-'))
    const binary = join(dir, 'gh')
    await writeFile(binary, '#!/bin/sh\nexit 0\n')
    await chmod(binary, 0o755)
    mocks.resolveBinary.mockResolvedValue(null)
    shellPath = `${dir}:/usr/bin:/bin`
    try {
      await expect(github.resolveGhBinary()).resolves.toBe(binary)
      await expect(github.resolveGhBinary()).resolves.toBe(binary)
      expect(
        mocks.execFile.mock.calls.filter((call) => call[1]?.[0] === '-lic')
      ).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads issue and PR details with empty donor defaults', async () => {
    queue({
      args: [
        'pr',
        'view',
        '42',
        '--json',
        'body,author,baseRefName,headRefName,reviewDecision'
      ],
      stdout: JSON.stringify({
        body: 'Details',
        author: { login: 'octo' },
        baseRefName: 'main',
        headRefName: 'topic',
        reviewDecision: null
      })
    })

    await expect(github.githubDetails('/repo', 'pr', 42)).resolves.toEqual({
      body: 'Details',
      author: 'octo',
      authorAvatarUrl: 'https://avatars.githubusercontent.com/octo?s=64',
      baseRefName: 'main',
      headRefName: 'topic',
      reviewDecision: ''
    })
    await expect(github.githubDetails('/repo', 'gist', 42)).rejects.toThrow(
      'Unknown GitHub task kind'
    )
  })

  it('passes a known repo to gh and skips the repo lookup for a thread', async () => {
    queue({
      args: ['issue', 'view', '7', '--json', 'body,author', '-R', 'acme/web'],
      stdout: JSON.stringify({ body: 'B', author: { login: 'octo' } })
    })
    await expect(github.githubDetails('/repo', 'issue', 7, ' acme/web ')).resolves.toMatchObject({
      body: 'B',
      author: 'octo'
    })
    await expect(github.githubDetails('/repo', 'issue', 7, 'nonsense')).rejects.toThrow(
      'GitHub did not return a repository'
    )

    queue({
      args: [
        'api',
        'graphql',
        '-f',
        expect.stringContaining('query InboxIssueThread') as unknown as string,
        '-F',
        'owner=acme',
        '-F',
        'name=web',
        '-F',
        'number=7'
      ],
      stdout: JSON.stringify({
        data: { repository: { issue: { comments: { totalCount: 0, nodes: [] } } } }
      })
    })
    await expect(github.githubThread('/repo', 'issue', 7, 'acme/web')).resolves.toMatchObject({
      comments: [],
      truncated: false
    })
  })

  it('merges PR comments, reviews, and review threads and reports truncation', async () => {
    queue(
      {
        args: ['repo', 'view', '--json', 'nameWithOwner'],
        stdout: '{"nameWithOwner":"acme/web"}'
      },
      {
        args: [
          'api',
          'graphql',
          '-f',
          expect.stringContaining('query InboxPullRequestThread') as unknown as string,
          '-F',
          'owner=acme',
          '-F',
          'name=web',
          '-F',
          'number=9'
        ],
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewDecision: 'CHANGES_REQUESTED',
                baseRefName: 'main',
                headRefName: 'topic',
                comments: {
                  totalCount: 3,
                  nodes: [
                    {
                      id: 'IC_1',
                      author: { login: 'alice' },
                      body: 'Conversation',
                      createdAt: '2026-09-03T00:00:00Z',
                      url: 'https://github.test/comment/1',
                      isMinimized: false
                    },
                    { id: 'IC_hidden', isMinimized: true }
                  ]
                },
                reviews: {
                  totalCount: 2,
                  nodes: [
                    {
                      id: 'R_1',
                      author: { login: 'bob' },
                      body: 'Needs work',
                      state: 'changes_requested',
                      submittedAt: '2026-09-02T00:00:00Z',
                      url: 'https://github.test/review/1'
                    },
                    { id: 'R_pending', state: 'PENDING' }
                  ]
                },
                reviewThreads: {
                  totalCount: 2,
                  nodes: [
                    {
                      id: 'PRRT_1',
                      isResolved: true,
                      path: 'src/a.ts',
                      comments: {
                        totalCount: 2,
                        nodes: [
                          {
                            id: 'RC_1',
                            author: { login: 'carol' },
                            body: 'Inline',
                            createdAt: '2026-09-01T00:00:00Z',
                            url: 'https://github.test/review-comment/1',
                            originalLine: 8
                          },
                          {
                            id: 'RC_2',
                            author: { login: 'dan' },
                            body: 'Reply',
                            createdAt: '2026-09-01T01:00:00Z',
                            url: 'https://github.test/review-comment/2',
                            line: 9
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        })
      }
    )

    const result = await github.githubThread('/repo', 'pr', 9)
    expect(result.truncated).toBe(true)
    expect(result.reviewDecision).toBe('CHANGES_REQUESTED')
    expect(result.baseRefName).toBe('main')
    expect(result.headRefName).toBe('topic')
    expect(result.comments.map((comment) => comment.kind)).toEqual([
      'review_comment',
      'review',
      'comment'
    ])
    expect(result.comments[0]).toMatchObject({
      id: 'RC_1',
      path: 'src/a.ts',
      line: 8,
      resolved: true,
      threadId: 'PRRT_1',
      replies: [{ id: 'RC_2', line: 9, threadId: 'PRRT_1' }]
    })
    expect(result.comments[1]).toMatchObject({ state: 'CHANGES_REQUESTED' })
  })

  it('posts comments and GraphQL replies through cleaned-up Markdown files', async () => {
    let commentPath = ''
    let replyPath = ''
    queue(
      {
        args: [
          'issue',
          'comment',
          '12',
          '--body-file',
          expect.stringContaining('monocode-comment-') as unknown as string
        ],
        stdout: 'posted\nhttps://github.test/acme/web/issues/12#issuecomment-1',
        inspect: (args) => {
          commentPath = args[4]
          expect(readFileSync(commentPath, 'utf8')).toBe('Looks good')
        }
      },
      {
        args: [
          'api',
          'graphql',
          '-f',
          expect.stringContaining('mutation InboxReviewReply') as unknown as string,
          '-F',
          'threadId=PRRT_abc-123=',
          '-F',
          expect.stringContaining('body=@') as unknown as string
        ],
        stdout: '{"errors":[{"message":"thread is locked"}]}',
        inspect: (args) => {
          replyPath = args[7].slice('body=@'.length)
          expect(readFileSync(replyPath, 'utf8')).toBe('Reply text')
        }
      }
    )

    await expect(
      github.githubComment('/repo', 'issue', 12, '  Looks good  ')
    ).resolves.toBe('https://github.test/acme/web/issues/12#issuecomment-1')
    expect(existsSync(commentPath)).toBe(false)
    await expect(
      github.githubComment('/repo', 'pr', 12, ' Reply text ', ' PRRT_abc-123= ')
    ).rejects.toThrow('thread is locked')
    expect(existsSync(replyPath)).toBe(false)
  })

  it('returns PR file metadata and drops patches over the two MiB cap', async () => {
    const meta = JSON.stringify({
      additions: 0,
      deletions: 0,
      files: [
        { path: 'a.ts', additions: 3, deletions: 1 },
        { path: 'b.ts', additions: 2, deletions: 4 }
      ]
    })
    queue(
      {
        args: ['pr', 'view', '7', '--json', 'files,additions,deletions'],
        stdout: meta
      },
      { args: ['pr', 'diff', '7'], stdout: 'diff --git a/a.ts b/a.ts\n' },
      {
        args: ['pr', 'view', '8', '--json', 'files,additions,deletions'],
        stdout: meta
      },
      { args: ['pr', 'diff', '8'], stdout: 'x'.repeat(2 * 1024 * 1024 + 1) }
    )

    await expect(github.githubPrDiff('/repo', 7)).resolves.toMatchObject({
      additions: 5,
      deletions: 5,
      patch: 'diff --git a/a.ts b/a.ts',
      truncated: false
    })
    await expect(github.githubPrDiff('/repo', 8)).resolves.toMatchObject({
      additions: 5,
      deletions: 5,
      patch: '',
      truncated: true
    })
  })

  it('finds the open PR for the current branch and surfaces gh failures', async () => {
    queue(
      {
        program: 'git',
        args: ['--no-pager', '-C', '/repo', 'symbolic-ref', '--short', 'HEAD'],
        stdout: 'topic\n'
      },
      {
        args: [
          'pr',
          'list',
          '--head',
          'topic',
          '--json',
          'number,title,url,state',
          '--limit',
          '20',
          '--state',
          'all'
        ],
        stdout: JSON.stringify([
          { number: 1, title: 'Old', url: 'https://github.test/pr/1', state: 'CLOSED' },
          { number: 2, title: 'Open', url: 'https://github.test/pr/2', state: 'OPEN' }
        ])
      },
      {
        program: 'git',
        args: ['--no-pager', '-C', '/repo', 'symbolic-ref', '--short', 'HEAD'],
        stdout: 'topic\n'
      },
      {
        args: [
          'pr',
          'list',
          '--head',
          'topic',
          '--json',
          'number,title,url,state',
          '--limit',
          '20',
          '--state',
          'all'
        ],
        error: failure(),
        stderr: 'authentication required'
      },
      {
        program: 'git',
        args: ['--no-pager', '-C', '/repo', 'symbolic-ref', '--short', 'HEAD'],
        error: failure()
      },
      {
        program: 'git',
        args: ['--no-pager', '-C', '/repo', 'rev-parse', '--short', 'HEAD'],
        error: failure()
      }
    )

    await expect(github.githubPrStatus('/repo')).resolves.toEqual({
      number: 2,
      title: 'Open',
      url: 'https://github.test/pr/2',
      state: 'open'
    })
    await expect(github.githubPrStatus('/repo')).rejects.toThrow('authentication required')
    await expect(github.githubPrStatus('/repo')).resolves.toBeNull()
  })

  it('creates PRs through a body file and removes it after success and failure', async () => {
    let successPath = ''
    let failedPath = ''
    const expectedArgs = (
      path: string | unknown
    ): string[] => [
      'pr',
      'create',
      '--title',
      'Add feature',
      '--body-file',
      path as string,
      '--base',
      'main',
      '--head',
      'topic'
    ]
    queue(
      {
        args: expectedArgs(expect.stringContaining('monocode-pr-')),
        stdout: 'https://github.test/acme/web/pull/88\n',
        inspect: (args) => {
          successPath = args[5]
          expect(readFileSync(successPath, 'utf8')).toBe('PR body')
        }
      },
      {
        args: expectedArgs(expect.stringContaining('monocode-pr-')),
        error: failure(),
        stderr: 'base branch not found',
        inspect: (args) => {
          failedPath = args[5]
          expect(readFileSync(failedPath, 'utf8')).toBe('PR body')
        }
      }
    )

    await expect(
      github.githubCreatePr('/repo', ' Add feature ', ' PR body ', ' main ', ' topic ')
    ).resolves.toBe('https://github.test/acme/web/pull/88')
    expect(existsSync(successPath)).toBe(false)
    await expect(
      github.githubCreatePr('/repo', ' Add feature ', ' PR body ', ' main ', ' topic ')
    ).rejects.toThrow('base branch not found')
    expect(existsSync(failedPath)).toBe(false)
  })
})
