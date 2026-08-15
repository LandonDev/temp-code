/**
 * Best-effort plain-English label for a shell command — what the model is
 * doing, not how. The raw command stays one click away in the row's
 * expansion, so this only has to be honest, short, and readable.
 */

/** `/bin/zsh -lc '…'` → `…` — drop the shell wrapper and its quotes. */
function unwrap(raw: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/.exec(raw.trim())
  if (!m) return raw.trim()
  const rest = m[1].trim()
  const q = /^(['"])([\s\S]*)\1$/.exec(rest)
  return (q ? q[2] : rest).trim()
}

/** Split on top-level `&&`, `||`, `|`, `;`, newlines — quote-aware. */
function segments(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      cur += c
      if (c === quote && cmd[i - 1] !== '\\') quote = null
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c
      cur += c
    } else if (c === '\n' || c === ';') {
      out.push(cur)
      cur = ''
    } else if ((c === '&' || c === '|') && cmd[i + 1] === c) {
      out.push(cur)
      cur = ''
      i++
    } else if (c === '|') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

const strip = (s: string): string => s.replace(/\\(["'])/g, '$1').replace(/^['"`]|['"`]$/g, '')
const base = (p: string): string => strip(p).replace(/\/+$/, '').split('/').pop() ?? p
const short = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const isRedirect = (a: string): boolean => /^\d*[<>]/.test(a) || a.includes('>')

/** First argument that isn't a flag or a redirect. */
function fileArg(args: string[]): string | undefined {
  for (const a of args) {
    if (isRedirect(a)) return undefined
    if (a.startsWith('-')) continue
    return a
  }
  return undefined
}

/** One segment → a short phrase, or null for pure pipe noise (awk, sort…). */
function phrase(seg: string): string | null {
  // Redirected writes read as writes no matter the producer.
  const redirect = />>?\s*(\S+)/.exec(seg)
  const words = seg.split(/\s+/)
  // Skip env prefixes (FOO=bar cmd) and `env`/`sudo`/`xargs` wrappers.
  let i = 0
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === 'env')) i++
  if (words[i] === 'sudo') i++
  if (words[i] === 'xargs') {
    i++
    while (i < words.length && words[i].startsWith('-')) i++
  }
  const cmd = base(words[i] ?? '')
  const args = words.slice(i + 1)
  const file = fileArg(args)

  switch (cmd) {
    case 'cd':
    case 'pwd':
    case 'true':
    case 'exit':
      return null
    // Pure stream filters — only meaningful as part of another segment.
    case 'awk':
    case 'sort':
    case 'uniq':
    case 'cut':
    case 'tr':
    case 'jq':
    case 'tee':
    case 'grep':
    case 'head':
    case 'tail':
      // grep/head/tail WITH a file operand are reads; bare ones filter a pipe.
      if ((cmd === 'grep' || cmd === 'head' || cmd === 'tail') && file) {
        return cmd === 'grep' ? `search ${base(file)}` : `read ${base(file)}`
      }
      return null
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'))
      switch (sub) {
        case 'status':
          return 'check git status'
        case 'log':
          return 'read git history'
        case 'diff':
          return 'view the diff'
        case 'ls-files':
          return 'list tracked files'
        case 'add':
          return 'stage changes'
        case 'commit':
          return 'commit'
        case 'push':
          return 'push'
        case 'pull':
        case 'fetch':
          return 'sync with the remote'
        case 'checkout':
        case 'switch':
          return 'switch branches'
        case 'branch':
          return 'list branches'
        case 'stash':
          return 'stash changes'
        case 'show':
          return 'show a commit'
        case 'blame':
          return `check blame${file ? ` on ${base(args.at(-1) ?? '')}` : ''}`
        default:
          return sub ? `git ${sub}` : 'run git'
      }
    }
    case 'rg':
    case 'ag':
    case 'ack': {
      const pat = args.find((a) => !a.startsWith('-'))
      return pat ? `search for ${short(strip(pat), 24)}` : 'search the code'
    }
    case 'sed': {
      // The common read idiom: sed -n '1,120p' file
      const f = args
        .filter((a) => !a.startsWith('-') && !isRedirect(a) && !/^['"]?[\d,$]+p['"]?$/.test(a))
        .at(-1)
      if (/-n/.test(seg) && f && !f.includes('s/')) return `read ${base(f)}`
      return null // otherwise it's a pipe transform
    }
    case 'cat':
    case 'less':
    case 'more':
    case 'bat':
      return file ? `read ${base(file)}` : null
    case 'ls':
      return 'list files'
    case 'find':
      return 'find files'
    case 'wc':
      return file ? `count lines in ${base(file)}` : null
    case 'tree':
      return 'view the file tree'
    case 'mvn':
    case 'mvnw':
      if (args.some((a) => a === 'test' || a.includes('test'))) return 'run the Maven tests'
      if (args.includes('validate')) return 'validate the Maven build'
      if (args.some((a) => ['package', 'install', 'compile', 'verify'].includes(a)))
        return 'build with Maven'
      return 'run Maven'
    case 'gradle':
    case 'gradlew':
      return args.includes('test') ? 'run the Gradle tests' : 'build with Gradle'
    case 'npm':
    case 'pnpm':
    case 'bun':
    case 'yarn': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (sub === 'test' || sub === 't') return 'run the tests'
      if (sub === 'install' || sub === 'i' || sub === 'add') return 'install dependencies'
      if (sub === 'run') return `run "${args[args.indexOf('run') + 1] ?? 'script'}"`
      return sub ? `${cmd} ${sub}` : `run ${cmd}`
    }
    case 'npx':
    case 'bunx':
      return file ? `run ${base(file)}` : `run ${cmd}`
    case 'cargo':
    case 'go':
      return args[0] === 'test'
        ? 'run the tests'
        : args[0] === 'build'
          ? 'build the project'
          : `${cmd} ${args[0] ?? ''}`.trim()
    case 'pytest':
    case 'jest':
    case 'vitest':
      return 'run the tests'
    case 'make':
      return file ? `make ${file}` : 'run make'
    case 'tsc':
      return 'typecheck'
    case 'python':
    case 'python3':
    case 'node':
    case 'ruby':
    case 'perl':
      if (args.includes('-c') || args.includes('-e')) {
        const lang = cmd.startsWith('python') ? 'Python' : cmd === 'node' ? 'JS' : cmd
        return `run a ${lang} snippet`
      }
      return file ? `run ${base(file)}` : `run ${cmd}`
    case 'curl':
    case 'wget': {
      const url = args.find((a) => /^https?:\/\//.test(strip(a)))
      try {
        return url ? `fetch ${new URL(strip(url)).hostname}` : 'fetch a URL'
      } catch {
        return 'fetch a URL'
      }
    }
    case 'mkdir':
      return 'create a directory'
    case 'touch':
      return file ? `create ${base(file)}` : 'create a file'
    case 'rm':
      return file ? `delete ${base(file)}` : 'delete files'
    case 'cp':
      return file ? `copy ${base(file)}` : 'copy files'
    case 'mv':
      return file ? `move ${base(file)}` : 'move files'
    case 'chmod':
    case 'chown':
      return 'change permissions'
    case 'echo':
    case 'printf':
      return redirect ? `write ${base(redirect[1])}` : null
    case 'test':
      return file ? `check ${base(args.at(-1) ?? '')}` : null
    case 'command':
    case 'which':
    case 'type':
      return `check for ${base(args.filter((a) => !a.startsWith('-')).at(-1) ?? 'a tool')}`
    case 'sqlite3':
      return 'query a database'
    case 'diff':
      return 'compare files'
    case 'tar':
    case 'zip':
    case 'unzip':
      return 'work with an archive'
    case 'codex':
      return 'run Codex'
    default:
      if (redirect) return `write ${base(redirect[1])}`
      return cmd ? `run ${cmd}` : null
  }
}

/** The row label: up to three distinct phrases joined with " · ". */
export function humanizeCommand(raw: string): string {
  const cmd = unwrap(raw)
  const phrases: string[] = []
  for (const seg of segments(cmd)) {
    const p = phrase(seg)
    if (p && !phrases.includes(p)) phrases.push(p)
  }
  const extra = phrases.length - 3
  const shown = phrases.slice(0, 3).join(' · ')
  const label = extra > 0 ? `${shown} +${extra} more` : shown
  const text = label || short(cmd.replace(/\s*\n\s*/g, ' '), 80)
  return text.charAt(0).toUpperCase() + text.slice(1)
}
