import { type ExecFileException } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, constants, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessEnv, resolveBinary } from './drivers/binaries'
import { execFileBudgeted } from './spawnBudget'

export type GitHubTaskKind = 'issue' | 'pr'

export interface GitHubLabel {
  name: string
  color: string
}

export interface GitHubAssignee {
  login: string
  avatarUrl: string
}

export interface GitHubWorkItemDetails {
  body: string
  author: string
  authorAvatarUrl: string
  baseRefName: string
  headRefName: string
  reviewDecision: string
}

export interface GitHubWorkItemComment {
  id: string
  kind: string
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  state: string
  path: string
  line: number | null
  resolved: boolean
  threadId: string
  replies: GitHubWorkItemComment[]
}

export interface GitHubWorkItemThread {
  comments: GitHubWorkItemComment[]
  truncated: boolean
  reviewDecision: string
  baseRefName: string
  headRefName: string
}

export interface GitHubPrFile {
  path: string
  additions: number
  deletions: number
}

export interface GitHubPrDiff {
  additions: number
  deletions: number
  files: GitHubPrFile[]
  patch: string
  truncated: boolean
}

export interface GitHubPr {
  number: number
  title: string
  url: string
  state: string
}

const MAX_PR_DIFF_BYTES = 2 * 1024 * 1024
const COMMAND_MAX_BUFFER = 64 * 1024 * 1024
const LOGIN_SHELL_TIMEOUT_MS = 5_000

const ISSUE_THREAD_QUERY = `
query InboxIssueThread($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          createdAt
          url
          isMinimized
        }
      }
    }
  }
}
`

const PR_THREAD_QUERY = `
query InboxPullRequestThread($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      baseRefName
      headRefName
      comments(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          createdAt
          url
          isMinimized
        }
      }
      reviews(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          state
          submittedAt
          url
        }
      }
      reviewThreads(last: 20) {
        totalCount
        nodes {
          id
          isResolved
          path
          comments(first: 8) {
            totalCount
            nodes {
              id
              author { login }
              body
              createdAt
              url
              path
              line
              originalLine
              isMinimized
            }
          }
        }
      }
    }
  }
}
`

const REVIEW_REPLY_MUTATION = `
mutation InboxReviewReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment { url }
  }
}
`

interface CommandResult {
  error: ExecFileException | null
  stdout: string
  stderr: string
}

function runCommand(
  program: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
    maxBuffer?: number
  } = {}
): Promise<CommandResult> {
  return execFileBudgeted(program, args, { ...options, encoding: 'utf8' }).then(
    ({ stdout, stderr }) => ({ error: null, stdout, stderr }),
    (error: ExecFileException & { stdout?: string; stderr?: string }) => ({
      error,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    })
  )
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

let interactivePathPromise: Promise<string | null> | null = null

function interactiveShellPath(): Promise<string | null> {
  interactivePathPromise ??= (async () => {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const result = await runCommand(shell, ['-lic', 'printenv PATH'], {
      env: process.env,
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    })
    if (result.error) return null
    return result.stdout.trim() || null
  })()
  return interactivePathPromise
}

let ghSearchPathPromise: Promise<string> | null = null

function ghSearchPath(): Promise<string> {
  ghSearchPathPromise ??= (async () => {
    const parts: string[] = []
    const add = (path: string | undefined): void => {
      if (!path) return
      for (const part of path.split(':')) {
        if (part && !parts.includes(part)) parts.push(part)
      }
    }
    add((await interactiveShellPath()) ?? undefined)
    add(join(homedir(), '.local/bin'))
    add(join(homedir(), '.cargo/bin'))
    add(join(homedir(), '.npm-global/bin'))
    add('/opt/homebrew/bin')
    add('/usr/local/bin')
    add('/usr/bin')
    add('/bin')
    add('/snap/bin')
    add(process.env.PATH)
    return parts.join(':')
  })()
  return ghSearchPathPromise
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let ghBinaryPromise: Promise<string | null> | null = null

export function resolveGhBinary(): Promise<string | null> {
  ghBinaryPromise ??= (async () => {
    const existing = await resolveBinary('gh')
    if (existing) return existing
    for (const dir of (await ghSearchPath()).split(':')) {
      if (!dir) continue
      const candidate = join(dir, 'gh')
      if (await isExecutable(candidate)) return candidate
    }
    return null
  })()
  return ghBinaryPromise
}

async function ghEnvironment(): Promise<NodeJS.ProcessEnv> {
  return {
    ...(await harnessEnv()),
    PATH: await ghSearchPath(),
    GIT_TERMINAL_PROMPT: '0',
    GH_PAGER: 'cat',
    GIT_PAGER: 'cat'
  }
}

async function ghRun(cwd: string, args: readonly string[], allowEmpty = false): Promise<string> {
  const program = await resolveGhBinary()
  if (!program) throw new Error('GitHub CLI (`gh`) is not installed.')
  const result = await runCommand(program, args, {
    cwd: expandHome(cwd),
    env: await ghEnvironment(),
    maxBuffer: COMMAND_MAX_BUFFER
  })
  if (!result.error) {
    const text = result.stdout.trim()
    if (text || allowEmpty) return text
    throw new Error('gh returned no output')
  }
  if (result.error.code === 'ENOENT') throw new Error('GitHub CLI (`gh`) is not installed.')
  const stderr = result.stderr.trim()
  if (stderr) throw new Error(stderr)
  const stdout = result.stdout.trim()
  if (stdout) throw new Error(stdout)
  if (result.error.code !== undefined && result.error.code !== null) {
    throw new Error(`gh ${args.join(' ')} failed`)
  }
  throw new Error(result.error.message)
}

/** Why a token could not be read; the inbox shows one sentence per class. */
export class GhAuthError extends Error {
  constructor(
    readonly state: 'missing-gh' | 'logged-out',
    message: string
  ) {
    super(message)
  }
}

let ghTokenPromise: Promise<string> | null = null

/**
 * The token `gh auth token` prints, read once per process and cached in
 * memory. The main-process GraphQL fetch sends it as a bearer; it never
 * enters a log, a push, or a result. `forgetGhToken` drops it after a 401.
 */
export function ghAuthToken(): Promise<string> {
  ghTokenPromise ??= (async () => {
    const program = await resolveGhBinary()
    if (!program) {
      throw new GhAuthError(
        'missing-gh',
        'Install the GitHub CLI (gh) and run gh auth login to see pull requests and issues.'
      )
    }
    const result = await runCommand(program, ['auth', 'token'], {
      env: await ghEnvironment(),
      maxBuffer: 1024 * 1024
    })
    const token = result.stdout.trim()
    if (result.error?.code === 'ENOENT') {
      throw new GhAuthError(
        'missing-gh',
        'Install the GitHub CLI (gh) and run gh auth login to see pull requests and issues.'
      )
    }
    if (result.error || !token) {
      throw new GhAuthError('logged-out', 'Run gh auth login to connect GitHub.')
    }
    return token
  })()
  ghTokenPromise.catch(() => {
    ghTokenPromise = null // a failed read is retried on the next call
  })
  return ghTokenPromise
}

export function forgetGhToken(): void {
  ghTokenPromise = null
}

async function gitStdout(cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await runCommand('git', ['--no-pager', '-C', expandHome(cwd), ...args], {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0'
    },
    maxBuffer: COMMAND_MAX_BUFFER
  })
  if (result.error) return null
  return result.stdout.trim() || null
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${description} returned by GitHub`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${description} returned by GitHub`)
  return value
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Invalid ${key} returned by GitHub`)
  return value
}

function optionalString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`Invalid ${key} returned by GitHub`)
  return value
}

function optionalBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key} returned by GitHub`)
  return value
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${key} returned by GitHub`)
  return value as number
}

function optionalInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${key} returned by GitHub`)
  return value as number
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function avatarUrl(login: string): string {
  const trimmed = login.trim()
  if (!trimmed) return ''
  let encoded = ''
  for (const byte of Buffer.from(trimmed)) {
    const safe =
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      (byte >= 48 && byte <= 57) ||
      byte === 45 ||
      byte === 46 ||
      byte === 95
    encoded += safe ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `https://avatars.githubusercontent.com/${encoded}?s=64`
}

function validKind(kind: string): GitHubTaskKind {
  const trimmed = kind.trim()
  if (trimmed !== 'issue' && trimmed !== 'pr') throw new Error('Unknown GitHub task kind')
  return trimmed
}

function validItemNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid GitHub item number')
}

function splitRepo(slug: string): [string, string] {
  const trimmed = slug.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash !== trimmed.lastIndexOf('/')) {
    throw new Error('GitHub did not return a repository')
  }
  const owner = trimmed.slice(0, slash).trim()
  const name = trimmed.slice(slash + 1).trim()
  if (!owner || !name || /\s/.test(owner) || /\s/.test(name)) {
    throw new Error('GitHub did not return a repository')
  }
  return [owner, name]
}

export async function githubRepo(cwd: string): Promise<string> {
  const output = await ghRun(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  const slug = requiredString(record(parseJson(output), 'repository'), 'nameWithOwner').trim()
  if (!slug || !slug.includes('/')) throw new Error('GitHub did not return a repository')
  return slug
}

/** `repo` ("owner/name"), when the caller knows it, spares gh its own lookup. */
export async function githubDetails(
  cwd: string,
  kindInput: string,
  number: number,
  repo?: string
): Promise<GitHubWorkItemDetails> {
  const kind = validKind(kindInput)
  const fields =
    kind === 'pr' ? 'body,author,baseRefName,headRefName,reviewDecision' : 'body,author'
  const slug = repo?.trim() ? splitRepo(repo).join('/') : null
  const output = await ghRun(cwd, [
    kind,
    'view',
    number.toString(),
    '--json',
    fields,
    ...(slug ? ['-R', slug] : [])
  ])
  const row = record(parseJson(output), 'work item details')
  const authorValue = row.author
  const author =
    authorValue === undefined || authorValue === null
      ? ''
      : optionalString(record(authorValue, 'author'), 'login')
  return {
    body: optionalString(row, 'body'),
    author,
    authorAvatarUrl: avatarUrl(author),
    baseRefName: optionalString(row, 'baseRefName'),
    headRefName: optionalString(row, 'headRefName'),
    reviewDecision: optionalString(row, 'reviewDecision')
  }
}

interface ParsedNodes {
  totalCount: number
  nodes: unknown[]
}

function nodes(row: Record<string, unknown>, key: string): ParsedNodes {
  const value = row[key]
  if (value === undefined) return { totalCount: 0, nodes: [] }
  const container = record(value, key)
  return {
    totalCount: requiredInteger(container, 'totalCount'),
    nodes: array(container.nodes, `${key} nodes`)
  }
}

function actorLogin(value: unknown): string {
  if (value === undefined || value === null) return ''
  return optionalString(record(value, 'author'), 'login').trim()
}

function mappedComment(
  value: unknown,
  kind: string,
  fallbackPath: string,
  resolved: boolean
): GitHubWorkItemComment | null {
  const row = record(value, 'comment')
  if (optionalBoolean(row, 'isMinimized')) return null
  const author = actorLogin(row.author)
  const createdAt = optionalString(row, 'createdAt').trim()
  const rawId = optionalString(row, 'id').trim()
  const rawPath = optionalString(row, 'path').trim()
  const lineValue = row.line ?? row.originalLine
  let line: number | null = null
  if (lineValue !== undefined && lineValue !== null) {
    if (!Number.isSafeInteger(lineValue)) throw new Error('Invalid line returned by GitHub')
    line = lineValue as number
  }
  return {
    id: rawId || `${kind}:${author}:${createdAt}`,
    kind,
    author,
    authorAvatarUrl: avatarUrl(author),
    body: optionalString(row, 'body'),
    createdAt,
    url: optionalString(row, 'url'),
    state: '',
    path: rawPath || fallbackPath.trim(),
    line,
    resolved,
    threadId: '',
    replies: []
  }
}

function reviewComment(value: unknown): GitHubWorkItemComment | null {
  const row = record(value, 'review')
  const state = optionalString(row, 'state').trim().toUpperCase()
  if (!state || state === 'PENDING') return null
  const body = optionalString(row, 'body')
  if (state === 'COMMENTED' && !body.trim()) return null
  const createdAt = optionalString(row, 'submittedAt').trim()
  if (!createdAt) return null
  const author = actorLogin(row.author)
  const rawId = optionalString(row, 'id').trim()
  return {
    id: rawId || `review:${author}:${createdAt}`,
    kind: 'review',
    author,
    authorAvatarUrl: avatarUrl(author),
    body,
    createdAt,
    url: optionalString(row, 'url'),
    state,
    path: '',
    line: null,
    resolved: false,
    threadId: '',
    replies: []
  }
}

function reviewThread(value: unknown): GitHubWorkItemComment | null {
  const row = record(value, 'review thread')
  const threadId = optionalString(row, 'id').trim()
  const resolved = optionalBoolean(row, 'isResolved')
  const path = optionalString(row, 'path')
  const parsed = nodes(row, 'comments')
  const comments = parsed.nodes
    .map((comment) => mappedComment(comment, 'review_comment', path, resolved))
    .filter((comment): comment is GitHubWorkItemComment => comment !== null)
  const first = comments.shift()
  if (!first) return null
  first.threadId = threadId
  first.replies = comments.map((reply) => ({ ...reply, threadId }))
  return first
}

function graphqlError(envelope: Record<string, unknown>): string | null {
  const errorsValue = envelope.errors
  if (errorsValue === undefined) return null
  for (const value of array(errorsValue, 'GraphQL errors')) {
    const message = optionalString(record(value, 'GraphQL error'), 'message').trim()
    if (message) return message
  }
  return null
}

function compareComment(a: GitHubWorkItemComment, b: GitHubWorkItemComment): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function parseThread(output: string, kind: GitHubTaskKind): GitHubWorkItemThread {
  const envelope = record(parseJson(output), 'GraphQL response')
  const error = graphqlError(envelope)
  const dataValue = envelope.data
  const data = dataValue === undefined || dataValue === null ? null : record(dataValue, 'GraphQL data')
  const repoValue = data?.repository
  if (repoValue === undefined || repoValue === null) {
    throw new Error(error || 'GitHub item not found')
  }
  const repo = record(repoValue, 'repository')
  const comments: GitHubWorkItemComment[] = []
  let truncated = false
  let reviewDecision = ''
  let baseRefName = ''
  let headRefName = ''
  if (kind === 'pr') {
    if (repo.pullRequest === undefined || repo.pullRequest === null) {
      throw new Error(error || 'GitHub pull request not found')
    }
    const pull = record(repo.pullRequest, 'pull request')
    reviewDecision = optionalString(pull, 'reviewDecision')
    baseRefName = optionalString(pull, 'baseRefName')
    headRefName = optionalString(pull, 'headRefName')
    const conversation = nodes(pull, 'comments')
    truncated ||= conversation.nodes.length < conversation.totalCount
    for (const value of conversation.nodes) {
      const comment = mappedComment(value, 'comment', '', false)
      if (comment) comments.push(comment)
    }
    const reviews = nodes(pull, 'reviews')
    truncated ||= reviews.nodes.length < reviews.totalCount
    for (const value of reviews.nodes) {
      const comment = reviewComment(value)
      if (comment) comments.push(comment)
    }
    const threads = nodes(pull, 'reviewThreads')
    truncated ||= threads.nodes.length < threads.totalCount
    for (const value of threads.nodes) {
      const comment = reviewThread(value)
      if (comment) comments.push(comment)
    }
  } else {
    if (repo.issue === undefined || repo.issue === null) {
      throw new Error(error || 'GitHub issue not found')
    }
    const issue = record(repo.issue, 'issue')
    const conversation = nodes(issue, 'comments')
    truncated ||= conversation.nodes.length < conversation.totalCount
    for (const value of conversation.nodes) {
      const comment = mappedComment(value, 'comment', '', false)
      if (comment) comments.push(comment)
    }
  }
  comments.sort(compareComment)
  return { comments, truncated, reviewDecision, baseRefName, headRefName }
}

/** With `repo` ("owner/name") the `gh repo view` lookup is skipped. */
export async function githubThread(
  cwd: string,
  kindInput: string,
  number: number,
  repo?: string
): Promise<GitHubWorkItemThread> {
  const kind = validKind(kindInput)
  validItemNumber(number)
  const [owner, name] = splitRepo(repo?.trim() ? repo : await githubRepo(cwd))
  const query = kind === 'pr' ? PR_THREAD_QUERY : ISSUE_THREAD_QUERY
  const output = await ghRun(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${number}`
  ])
  return parseThread(output, kind)
}

async function withTempMarkdown<T>(prefix: string, body: string, run: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}.md`)
  await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  try {
    return await run(path)
  } finally {
    await unlink(path).catch(() => undefined)
  }
}

function validReviewThreadId(value: string): string {
  const id = value.trim()
  if (!id || id.length >= 256 || !/^[A-Za-z0-9_=-]+$/.test(id)) {
    throw new Error('Invalid review thread')
  }
  return id
}

function outputUrl(output: string, missing: string): string {
  const url = output
    .split('\n')
    .reverse()
    .map((line) => line.trim())
    .find((line) => line.startsWith('http://') || line.startsWith('https://'))
  if (url) return url
  throw new Error(output.trim() || missing)
}

function reviewReplyUrl(output: string): string {
  const envelope = record(parseJson(output), 'GraphQL response')
  const error = graphqlError(envelope)
  if (error) throw new Error(error)
  const data = envelope.data
  const reply = typeof data === 'object' && data !== null ? Reflect.get(data, 'addPullRequestReviewThreadReply') : null
  const comment = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'comment') : null
  const urlValue = typeof comment === 'object' && comment !== null ? Reflect.get(comment, 'url') : null
  const url = typeof urlValue === 'string' ? urlValue.trim() : ''
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  throw new Error('GitHub did not return a comment URL')
}

export async function githubComment(
  cwd: string,
  kindInput: string,
  number: number,
  bodyInput: string,
  inReplyToInput = ''
): Promise<string> {
  const kind = validKind(kindInput)
  validItemNumber(number)
  const body = bodyInput.trim()
  if (!body) throw new Error('Comment cannot be empty')
  const inReplyTo = inReplyToInput.trim()
  if (inReplyTo) {
    const threadId = validReviewThreadId(inReplyTo)
    return withTempMarkdown('monocode-comment', body, async (path) => {
      const output = await ghRun(cwd, [
        'api',
        'graphql',
        '-f',
        `query=${REVIEW_REPLY_MUTATION}`,
        '-F',
        `threadId=${threadId}`,
        '-F',
        `body=@${path}`
      ])
      return reviewReplyUrl(output)
    })
  }
  return withTempMarkdown('monocode-comment', body, async (path) => {
    const output = await ghRun(cwd, [kind, 'comment', number.toString(), '--body-file', path])
    return outputUrl(output, 'GitHub did not return a comment URL')
  })
}

function parsePrDiffMeta(output: string): GitHubPrDiff {
  const row = record(parseJson(output), 'pull request diff')
  const filesValue = row.files === undefined ? [] : array(row.files, 'pull request files')
  return {
    additions: optionalInteger(row, 'additions'),
    deletions: optionalInteger(row, 'deletions'),
    files: filesValue.map((value) => {
      const file = record(value, 'pull request file')
      return {
        path: requiredString(file, 'path'),
        additions: optionalInteger(file, 'additions'),
        deletions: optionalInteger(file, 'deletions')
      }
    }),
    patch: '',
    truncated: false
  }
}

export async function githubPrDiff(cwd: string, number: number): Promise<GitHubPrDiff> {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid pull request number')
  const numberText = number.toString()
  const meta = parsePrDiffMeta(
    await ghRun(cwd, ['pr', 'view', numberText, '--json', 'files,additions,deletions'])
  )
  const patch = await ghRun(cwd, ['pr', 'diff', numberText], true)
  if (Buffer.byteLength(patch) > MAX_PR_DIFF_BYTES) {
    meta.truncated = true
  } else {
    meta.patch = patch
  }
  if (meta.additions === 0 && meta.deletions === 0) {
    meta.additions = meta.files.reduce((sum, file) => sum + file.additions, 0)
    meta.deletions = meta.files.reduce((sum, file) => sum + file.deletions, 0)
  }
  return meta
}

function parsePrList(output: string): GitHubPr | null {
  const rows = array(parseJson(output), 'pull requests')
  let best: GitHubPr | null = null
  for (const value of rows) {
    const row = record(value, 'pull request')
    const pr = {
      number: requiredInteger(row, 'number'),
      title: requiredString(row, 'title'),
      url: requiredString(row, 'url'),
      state: requiredString(row, 'state').toLowerCase()
    }
    if (pr.state === 'open') return pr
    best ??= pr
  }
  return best
}

export async function githubPrStatus(cwd: string): Promise<GitHubPr | null> {
  const branch =
    (await gitStdout(cwd, ['symbolic-ref', '--short', 'HEAD'])) ??
    (await gitStdout(cwd, ['rev-parse', '--short', 'HEAD']))
  if (!branch) return null
  const output = await ghRun(cwd, [
    'pr',
    'list',
    '--head',
    branch,
    '--json',
    'number,title,url,state',
    '--limit',
    '20',
    '--state',
    'all'
  ])
  return parsePrList(output)
}

export async function githubCreatePr(
  cwd: string,
  titleInput: string,
  bodyInput: string,
  baseInput: string,
  headInput: string
): Promise<string> {
  const title = titleInput.trim()
  if (!title) throw new Error('Pull request title cannot be empty')
  return withTempMarkdown('monocode-pr', bodyInput.trim(), async (path) => {
    const output = await ghRun(cwd, [
      'pr',
      'create',
      '--title',
      title,
      '--body-file',
      path,
      '--base',
      baseInput.trim(),
      '--head',
      headInput.trim()
    ])
    const url = output
      .split('\n')
      .reverse()
      .find((line) => line.startsWith('http://') || line.startsWith('https://'))
    if (url) return url.trim()
    throw new Error(output.trim() || 'gh returned no pull request URL')
  })
}
