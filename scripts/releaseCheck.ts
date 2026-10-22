/**
 * Is there anything to release since the newest `release-N` tag? The
 * post-commit train and a batch's `release` step both run release.ts; with
 * nothing new since the tag (HEAD is the tagged commit, or every commit
 * since is release bookkeeping) it answers "nothing to release since
 * release-N" and exits 0 without a bump, a commit or a tag. A batch whose
 * end ran again with nothing landed once cut eight empty releases in a row.
 */
import { execFileSync } from 'node:child_process'

export interface CommitSummary {
  subject: string
  files: string[]
}

/** The files a release commit touches, and nothing else. */
const BOOKKEEPING_FILES = new Set(['release.json', 'package.json'])

/** release.ts's own commit: "release: vN — …", touching release.json and package.json only. */
export function isBookkeeping(c: CommitSummary): boolean {
  return /^release: v\d+\b/.test(c.subject) && c.files.length > 0 && c.files.every((f) => BOOKKEEPING_FILES.has(f))
}

/** True when the commits since the tag carry nothing to release (none, or bookkeeping only). */
export function nothingToRelease(commits: readonly CommitSummary[]): boolean {
  return commits.every(isBookkeeping)
}

/** The line release.ts prints for a no-op; batch.ts reads the tag back from it (`releaseOutcome`). */
export function nothingLine(tag: string): string {
  const n = tag.slice('release-'.length)
  return `nothing to release since ${tag} (package.json 1.0.${n})`
}

/** The commits in `tag..HEAD` with the files each touched, oldest first; null when the tag does not exist. */
export function commitsSince(tag: string, cwd: string, env: NodeJS.ProcessEnv = process.env): CommitSummary[] | null {
  const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    git(['rev-parse', '-q', '--verify', `${tag}^{commit}`])
  } catch {
    return null
  }
  const out = git(['log', '--reverse', '--no-merges', '--format=%x00%s', '--name-only', `${tag}..HEAD`])
  // Merge commits carry no files of their own; any merge since the tag brought something in.
  const merges = git(['rev-list', '--merges', '--count', `${tag}..HEAD`]).trim()
  const commits = out
    .split('\0')
    .slice(1)
    .map((chunk) => {
      const [subject, ...rest] = chunk.split('\n')
      return { subject, files: rest.map((l) => l.trim()).filter(Boolean) }
    })
  if (Number(merges) > 0) commits.push({ subject: 'merge', files: [] })
  return commits
}
