/**
 * Plain-English summaries for shell commands. Harnesses wrap everything in
 * `/bin/zsh -lc "…"` and env prefixes; users shouldn't have to read shell to
 * know what a turn did. The raw (unwrapped) command stays available for the
 * expansion — the summary is the row label, not a replacement for truth.
 */

export interface CommandSummary {
  /** present-progressive label while the tool runs, e.g. "Running a Python snippet" */
  doing: string
  /** past-tense label once done, e.g. "Ran a Python snippet" */
  done: string
  /** the command with shell wrappers stripped, for detail + expansion */
  command: string
}

/** Strip one layer of `zsh -lc '…'` / `bash -c "…"` wrapping. */
function unwrapShell(cmd: string): string | null {
  const m = cmd.match(/^(?:\S*\/)?(?:zsh|bash|sh|dash)\s+(?:-\w+\s+)*(['"])([\s\S]*)\1\s*$/)
  return m ? m[2] : null
}

/** Leading `env` calls and VAR=value assignments aren't the command. */
function stripEnvPrefix(cmd: string): string {
  let s = cmd.trimStart()
  s = s.replace(/^env\s+(?:-u\s+\w+\s+)*/, '')
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/, '')
  }
  return s
}

/** Split a script on top-level `&&`, `||`, `;`, `|` (quote-aware). */
function segments(script: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    if (quote) {
      cur += ch
      if (ch === quote && script[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      if (ch !== ';' && script[i + 1] === ch) i++
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const base = (p: string): string => p.replace(/['"]/g, '').split('/').pop() ?? p
/** First argument that looks like a file/dir operand, not a flag. */
function operand(words: string[]): string {
  const w = words.slice(1).find((x) => !x.startsWith('-') && !x.includes('='))
  return w ? base(w) : ''
}
const host = (url: string): string =>
  url
    .replace(/['"]/g, '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]

function pair(doing: string, done: string): [string, string] {
  return [doing, done]
}

const GIT: Record<string, [string, string]> = {
  status: pair('Checking git status', 'Checked git status'),
  diff: pair('Viewing the diff', 'Viewed the diff'),
  log: pair('Reading git history', 'Read git history'),
  show: pair('Reading a commit', 'Read a commit'),
  add: pair('Staging changes', 'Staged changes'),
  commit: pair('Committing', 'Committed changes'),
  push: pair('Pushing to the remote', 'Pushed to the remote'),
  pull: pair('Pulling latest', 'Pulled latest'),
  fetch: pair('Fetching from the remote', 'Fetched from the remote'),
  clone: pair('Cloning a repository', 'Cloned a repository'),
  checkout: pair('Switching branches', 'Switched branches'),
  switch: pair('Switching branches', 'Switched branches'),
  branch: pair('Listing branches', 'Listed branches'),
  stash: pair('Stashing changes', 'Stashed changes'),
  restore: pair('Restoring files', 'Restored files'),
  merge: pair('Merging', 'Merged'),
  rebase: pair('Rebasing', 'Rebased'),
  worktree: pair('Managing worktrees', 'Managed worktrees')
}

const PKG_VERBS: Record<string, [string, string]> = {
  install: pair('Installing dependencies', 'Installed dependencies'),
  add: pair('Adding a dependency', 'Added a dependency'),
  remove: pair('Removing a dependency', 'Removed a dependency'),
  uninstall: pair('Removing a dependency', 'Removed a dependency'),
  test: pair('Running tests', 'Ran tests'),
  build: pair('Building', 'Built the project'),
  ci: pair('Installing dependencies', 'Installed dependencies')
}

/** Describe one already-unwrapped simple command. */
function describeOne(cmd: string): [string, string] | null {
  const words = cmd.split(/\s+/)
  const prog = base(words[0] ?? '')
  const sub = words[1] ?? ''

  switch (prog) {
    case 'python':
    case 'python3':
      return words.includes('-c')
        ? pair('Running a Python snippet', 'Ran a Python snippet')
        : pair(`Running ${operand(words) || 'Python'}`, `Ran ${operand(words) || 'Python'}`)
    case 'node':
    case 'bun':
    case 'deno': {
      if (prog === 'bun' && PKG_VERBS[sub]) return PKG_VERBS[sub]
      if (prog === 'bun' && sub === 'run')
        return pair(`Running the ${words[2] ?? ''} script`, `Ran the ${words[2] ?? ''} script`)
      if (words.includes('-e') || words.includes('--eval'))
        return pair('Running a JavaScript snippet', 'Ran a JavaScript snippet')
      const f = operand(words)
      return f ? pair(`Running ${f}`, `Ran ${f}`) : null
    }
    case 'bc':
    case 'dc':
    case 'gp':
    case 'qalc':
      return pair('Running a calculation', 'Ran a calculation')
    case 'command':
    case 'which':
    case 'type':
    case 'whereis': {
      const name = prog === 'command' ? words[2] : words[1]
      return pair(`Checking for ${name ?? 'a tool'}`, `Checked for ${name ?? 'a tool'}`)
    }
    case 'git':
      return GIT[sub] ?? pair('Running a git command', 'Ran a git command')
    case 'ls':
    case 'tree':
    case 'exa':
    case 'eza':
      return pair('Listing files', 'Listed files')
    case 'find':
    case 'fd':
      return pair('Searching for files', 'Searched for files')
    case 'grep':
    case 'rg':
    case 'ag':
      return pair('Searching file contents', 'Searched file contents')
    case 'cat':
    case 'head':
    case 'tail':
    case 'bat':
    case 'less': {
      const f = operand(words)
      return f ? pair(`Reading ${f}`, `Read ${f}`) : pair('Reading a file', 'Read a file')
    }
    case 'wc':
      return pair('Counting lines', 'Counted lines')
    case 'mkdir':
      return pair('Creating a folder', 'Created a folder')
    case 'touch':
      return pair(`Creating ${operand(words) || 'a file'}`, `Created ${operand(words) || 'a file'}`)
    case 'rm':
      return pair(`Deleting ${operand(words) || 'files'}`, `Deleted ${operand(words) || 'files'}`)
    case 'mv':
      return pair('Moving files', 'Moved files')
    case 'cp':
    case 'rsync':
      return pair('Copying files', 'Copied files')
    case 'sed':
      return words.some((w) => w.startsWith('-i'))
        ? pair(
            `Editing ${operand(words.slice(1)) || 'a file'}`,
            `Edited ${operand(words.slice(1)) || 'a file'}`
          )
        : pair('Transforming text', 'Transformed text')
    case 'awk':
    case 'cut':
    case 'sort':
    case 'uniq':
    case 'tr':
    case 'jq':
      return pair('Processing text', 'Processed text')
    case 'echo':
    case 'printf':
      return cmd.includes('>')
        ? pair('Writing a file', 'Wrote a file')
        : pair('Printing text', 'Printed text')
    case 'curl':
    case 'wget':
    case 'http': {
      const url = words.find((w) => /^['"]?https?:\/\//.test(w))
      return pair(`Fetching ${url ? host(url) : 'a URL'}`, `Fetched ${url ? host(url) : 'a URL'}`)
    }
    case 'npm':
    case 'pnpm':
    case 'yarn':
      if (PKG_VERBS[sub]) return PKG_VERBS[sub]
      if (sub === 'run')
        return pair(`Running the ${words[2] ?? ''} script`, `Ran the ${words[2] ?? ''} script`)
      return pair(`Running ${prog} ${sub}`, `Ran ${prog} ${sub}`)
    case 'npx':
    case 'bunx':
      return pair(`Running ${base(sub)}`, `Ran ${base(sub)}`)
    case 'make':
      return pair(sub ? `Building ${sub}` : 'Building', sub ? `Built ${sub}` : 'Ran make')
    case 'cargo':
    case 'go':
    case 'mvn':
    case 'gradle':
    case 'gradlew':
      if (sub === 'test') return pair('Running tests', 'Ran tests')
      if (sub === 'build' || sub === 'compile') return pair('Building', 'Built the project')
      if (sub === 'run') return pair('Running the project', 'Ran the project')
      return pair(`Running ${prog} ${sub}`, `Ran ${prog} ${sub}`)
    case 'tsc':
      return pair('Type-checking', 'Type-checked')
    case 'eslint':
      return pair('Linting', 'Linted')
    case 'prettier':
      return pair('Formatting code', 'Formatted code')
    case 'vitest':
    case 'jest':
    case 'pytest':
      return pair('Running tests', 'Ran tests')
    case 'tar':
    case 'unzip':
    case 'zip':
    case 'gzip':
      return pair('Working with an archive', 'Handled an archive')
    case 'chmod':
    case 'chown':
      return pair('Changing permissions', 'Changed permissions')
    case 'kill':
    case 'pkill':
    case 'killall':
      return pair('Stopping a process', 'Stopped a process')
    case 'ps':
    case 'top':
    case 'lsof':
      return pair('Checking running processes', 'Checked running processes')
    case 'sleep':
      return pair('Waiting', 'Waited')
    case 'open':
      return pair(
        `Opening ${operand(words) || 'something'}`,
        `Opened ${operand(words) || 'something'}`
      )
    case 'osascript':
      return pair('Running an AppleScript', 'Ran an AppleScript')
    case 'sqlite3':
      return pair('Querying a database', 'Queried a database')
    case 'docker':
      return pair(`Running docker ${sub}`, `Ran docker ${sub}`)
    case 'gh':
      return pair(`Running gh ${sub}`, `Ran gh ${sub}`)
    case 'cd':
    case 'pwd':
      return pair('Navigating folders', 'Navigated folders')
    case 'diff':
      return pair('Comparing files', 'Compared files')
    case 'date':
    case 'cal':
      return pair('Checking the date', 'Checked the date')
    default:
      return null
  }
}

/** Home dirs display as `~` — never absolute paths in the transcript. */
const tilde = (s: string): string => s.replace(/\/Users\/[^/\s'"]+/g, '~')

export function summarizeCommand(raw: string): CommandSummary {
  // Peel wrappers: env prefixes and `zsh -lc "…"` layers, repeatedly.
  let cmd = raw.trim()
  for (let i = 0; i < 3; i++) {
    const stripped = stripEnvPrefix(cmd)
    const inner = unwrapShell(stripped)
    if (inner === null) {
      cmd = stripped === cmd ? cmd : stripped
      if (unwrapShell(cmd) === null && stripEnvPrefix(cmd) === cmd) break
      continue
    }
    cmd = inner.trim()
  }

  const parts = segments(cmd)

  // `command -v bc || command -v gp` → one "Checking for bc or gp".
  const probes = parts
    .map((p) => p.match(/^(?:command\s+-v|which|type)\s+(\S+)/)?.[1])
    .filter((x): x is string => !!x)
  if (probes.length && probes.length === parts.length) {
    const list = [...new Set(probes)].join(' or ')
    return { doing: `Checking for ${list}`, done: `Checked for ${list}`, command: tilde(cmd) }
  }

  // Describe the first recognizable segment; a pipeline's tail is plumbing.
  for (const part of parts) {
    const d = describeOne(stripEnvPrefix(part))
    if (d) return { doing: d[0], done: d[1], command: tilde(cmd) }
  }

  const prog = base(stripEnvPrefix(parts[0] ?? cmd).split(/\s+/)[0] ?? '')
  return {
    doing: prog ? `Running ${prog}` : 'Running a command',
    done: prog ? `Ran ${prog}` : 'Ran a command',
    command: tilde(cmd)
  }
}
