/**
 * Where a CLI lives on this host, found the way the app finds it (the real
 * user's login shell, then the caller's PATH, then the usual user bin dirs),
 * so a gate proof never depends on the PATH its caller happened to have: the
 * gate's children inherit a sparse one. Resolve before a rig swaps HOME for a
 * disposable one. The skills drivers rig and e2e-addons' codex leg use it.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { commandPathProbe, loginShell, withToolPath } from '../../src/main/server/loginShell'

export const GATE_CLIS = ['claude', 'codex', 'muse'] as const
export type GateCli = (typeof GATE_CLIS)[number]

export interface CliLookup {
  home: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  probe: (shell: string, args: string[], env: NodeJS.ProcessEnv) => string
  executable: (path: string) => boolean
}

/** The same last-resort user bin dirs as drivers/binaries.ts loginPath. */
const extraDirs = [
  '.local/bin',
  '.bun/bin',
  '.cargo/bin',
  '.local/share/cursor-agent',
  '.npm-global/bin'
]

/** Effects are supplied by the caller so lookup order and shell commands have pure tests. */
export function resolveGateCli(name: GateCli, lookup: CliLookup): string | null {
  const override = name === 'claude' ? lookup.env.TC_SD_GATE_CLAUDE_BIN : undefined
  if (override !== undefined)
    return isAbsolute(override) && lookup.executable(override) ? override : null
  const shell = loginShell(lookup.env, lookup.platform)
  try {
    const output = lookup.probe(
      shell,
      ['-lc', withToolPath(commandPathProbe(name, shell), lookup.platform)],
      { ...lookup.env, HOME: lookup.home }
    )
    // Shell profiles can print a greeting before the command path.
    for (const candidate of output
      .trim()
      .split('\n')
      .reverse()
      .map((s) => s.trim())) {
      if (isAbsolute(candidate) && lookup.executable(candidate)) return candidate
    }
  } catch {
    /* try the caller's PATH and then the app's usual user bin dirs */
  }
  const dirs = [
    ...(lookup.env.PATH ?? '').split(':'),
    ...extraDirs.map((d) => join(lookup.home, d))
  ]
  for (const dir of new Set(dirs.filter(Boolean))) {
    const candidate = join(dir, name)
    if (isAbsolute(candidate) && lookup.executable(candidate)) return candidate
  }
  return null
}

/** Every child and the app's login-shell PATH must use the paths we resolved. */
export function composeGatePath(
  paths: readonly (string | null)[],
  inherited: string,
  wrapperDir: string
): string {
  return [
    ...new Set(
      [
        wrapperDir,
        ...paths.filter((p): p is string => p !== null).map(dirname),
        ...inherited.split(':')
      ].filter(Boolean)
    )
  ].join(':')
}

export const shellWord = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`

/** `resolveGateCli` with this host's effects: the real HOME, a 20 s login-shell probe, executable files only. */
export function hostCli(name: GateCli, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME || homedir()
  return resolveGateCli(name, {
    home,
    env,
    platform: process.platform,
    probe: (shell, args, probeEnv) =>
      execFileSync(shell, args, { env: probeEnv, cwd: home, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }),
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
      } catch {
        return false
      }
    }
  })
}

/** Returning a message keeps the required-leg verdict separate from optional skips. */
export function claudeJudgeFailure(judges: readonly string[], why: string): string | null {
  return judges.includes('claude') ? null : `the Claude leg did not judge: ${why}`
}
