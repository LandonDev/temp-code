/**
 * The user's login shell: $SHELL, else zsh on macOS and bash elsewhere.
 * Every "ask the login shell" call (the PATH the CLIs live on, a build
 * command, a sign-in probe) goes through here, so a host without zsh
 * (Ubuntu) still finds what .profile puts on the PATH.
 *
 * `-lc` reads .zprofile/.zshenv (or .profile) but never .zshrc/.bashrc,
 * where many people put ~/.bun/bin on the PATH, so a job that runs a tool
 * by name (the release scripts, a batch shell step, a dev server, a build)
 * wraps its command in `withToolPath`: the usual tool dirs go first when
 * the PATH lacks them, and a PATH that has them is left as it is.
 */
export function loginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/**
 * The path of a command as the login shell resolves it, never a shell
 * function wrapping it: `whence -p` on zsh, `type -P` on bash, and
 * `command -v` where neither is known to exist.
 */
export function commandPathProbe(name: string, shell: string = loginShell()): string {
  const base = shell.split('/').pop() ?? shell
  if (base === 'zsh') return `whence -p ${name}`
  if (base === 'bash') return `type -P ${name}`
  return `command -v ${name}`
}

/** The dirs a tool usually lives in, in the order they should lead PATH. */
export function toolDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin'
    ? ['$HOME/.bun/bin', '/opt/homebrew/bin', '/usr/local/bin']
    : ['$HOME/.bun/bin', '$HOME/.local/bin']
}

/**
 * `command` behind a prelude that puts each of `toolDirs` on PATH when the
 * login shell's PATH lacks it, the first dir leading. Plain POSIX, so zsh,
 * bash and sh all read it.
 */
export function withToolPath(command: string, platform: NodeJS.Platform = process.platform): string {
  const dirs = toolDirs(platform).reverse().map((d) => `"${d}"`).join(' ')
  return `for d in ${dirs}; do case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac; done; export PATH; ${command}`
}
