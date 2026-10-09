import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitConfigMtime, githubRepoFromRemote, originRemoteUrl, parseOriginUrl } from './gitRemote'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-gitremote-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const config = (url: string | null): string =>
  `[core]\n\trepositoryformatversion = 0\n` +
  (url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '') +
  `[branch "master"]\n\tremote = origin\n`

describe('originRemoteUrl', () => {
  it('reads a main checkout (.git directory)', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), config('git@github.com:LandonDev/aliax.git'))
    expect(await originRemoteUrl(root)).toBe('git@github.com:LandonDev/aliax.git')
    expect(await gitConfigMtime(root)).toBeTypeOf('number')
  })

  it('follows a worktree (.git file with gitdir and commondir) to the shared config', async () => {
    const main = join(root, 'main')
    await mkdir(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    await writeFile(join(main, '.git', 'config'), config('https://github.com/o/n.git'))
    await writeFile(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = join(root, 'wt')
    await mkdir(wt)
    await writeFile(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    expect(await originRemoteUrl(wt)).toBe('https://github.com/o/n.git')
    const mtime = await gitConfigMtime(wt)
    await utimes(join(main, '.git', 'config'), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
    expect(await gitConfigMtime(wt)).not.toBe(mtime)
    expect(await gitConfigMtime(wt)).toBe(1_700_000_000_000)
  })

  it('reads a .git file without commondir at its gitdir', async () => {
    const gitdir = join(root, 'elsewhere')
    await mkdir(gitdir)
    await writeFile(join(gitdir, 'config'), config('ssh://git@github.com/o/n'))
    await writeFile(join(root, '.git'), 'gitdir: elsewhere\n')
    expect(await originRemoteUrl(root)).toBe('ssh://git@github.com/o/n')
  })

  it('is null without a remote, without a checkout, or on an unreadable path', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), config(null))
    expect(await originRemoteUrl(root)).toBeNull()
    expect(await originRemoteUrl(join(root, 'nope'))).toBeNull()
    expect(await gitConfigMtime(join(root, 'nope'))).toBeNull()
    await writeFile(join(root, 'plain'), 'x')
    expect(await originRemoteUrl(join(root, 'plain'))).toBeNull()
  })
})

describe('parseOriginUrl', () => {
  it('takes the first url of origin only', () => {
    expect(
      parseOriginUrl('[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = b\n\turl = c\n')
    ).toBe('b')
    expect(parseOriginUrl('[remote "upstream"]\n\turl = a\n')).toBeNull()
  })
})

describe('githubRepoFromRemote', () => {
  it.each([
    ['https://github.com/o/n.git', 'o/n'],
    ['https://github.com/o/n', 'o/n'],
    ['https://github.com/o/n/', 'o/n'],
    ['https://user@github.com/o/n.git', 'o/n'],
    ['git@github.com:o/n.git', 'o/n'],
    ['git@github.com:o/n', 'o/n'],
    ['ssh://git@github.com/o/n.git', 'o/n'],
    ['GIT@GITHUB.COM:Owner-x/Name.y.git', 'Owner-x/Name.y']
  ])('%s → %s', (url, slug) => {
    expect(githubRepoFromRemote(url)).toBe(slug)
  })

  it.each([
    'https://gitlab.com/o/n.git',
    'git@bitbucket.org:o/n.git',
    'https://github.acme.com/o/n.git',
    'https://github.com/o',
    'https://github.com/o/n/extra',
    'git@github.com:o/n$(x).git',
    ''
  ])('rejects %s', (url) => {
    expect(githubRepoFromRemote(url)).toBeNull()
  })
})
