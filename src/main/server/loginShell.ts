/**
 * The user's login shell: $SHELL, else zsh on macOS and bash elsewhere.
 * Every "ask the login shell" call (the PATH the CLIs live on, a build
 * command, a sign-in probe) goes through here, so a host without zsh
 * (Ubuntu) still finds what .profile puts on the PATH.
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
