import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

export interface TcComputerBuildOptions {
  root: string
  require?: boolean
  background?: boolean
  exec?: typeof execFileSync
  platform?: NodeJS.Platform
}

export interface TcComputerBuildResult {
  built: boolean
  skipped?: 'not-darwin' | 'up-to-date' | 'disabled'
  ms?: number
  error?: string
}

/** SHA-256 of Package.swift, optional Package.resolved and all Swift sources, by path and bytes. */
export function sourceStamp(root: string): string {
  const pkg = join(root, 'native/tc-computer')
  const files = [join(pkg, 'Package.swift')]
  if (existsSync(join(pkg, 'Package.resolved'))) files.push(join(pkg, 'Package.resolved'))
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.swift')) files.push(path)
    }
  }
  if (existsSync(join(pkg, 'Sources'))) walk(join(pkg, 'Sources'))
  const hash = createHash('sha256')
  for (const path of files.sort()) {
    hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0')
  }
  return hash.digest('hex')
}

export function buildTcComputer(opts: TcComputerBuildOptions): TcComputerBuildResult {
  if ((opts.platform ?? process.platform) !== 'darwin')
    return { built: false, skipped: 'not-darwin' }
  if (process.env.TEMP_CODE_SKIP_NATIVE === '1') return { built: false, skipped: 'disabled' }

  const { root } = opts
  const start = Date.now()
  const target = join(root, 'resources/native/tc-computer')
  const stampPath = `${target}.stamp`
  const args = [
    'build',
    '-c',
    'release',
    '--arch',
    'arm64',
    '--package-path',
    'native/tc-computer',
    '--product',
    'tc-computer'
  ]
  const xcodeArgs = [join(root, 'scripts/ios-xcode.sh')]
  const xcodeEnv = { ...process.env, TC_XCODE_MIN: '0' }
  const buildEnv = (developerDir: string) => {
    const env = { ...process.env }
    delete env.DEVELOPER_DIR
    if (developerDir.trim()) env.DEVELOPER_DIR = developerDir.trim()
    return env
  }
  // the background build's own failure only warns: nothing waits on it to throw to
  const fail = (error: unknown, rethrow = opts.require): TcComputerBuildResult => {
    console.warn('[tc-computer] swift build failed: computer use is off in this build')
    if (rethrow) throw error
    return { built: false, error: error instanceof Error ? error.message : String(error) }
  }

  let stamp: string
  const finish = (): TcComputerBuildResult => {
    const temp = join(dirname(target), `.tc-computer.${process.pid}.${Date.now()}.tmp`)
    mkdirSync(dirname(target), { recursive: true })
    try {
      copyFileSync(
        join(root, 'native/tc-computer/.build/arm64-apple-macosx/release/tc-computer'),
        temp
      )
      chmodSync(temp, 0o755)
      renameSync(temp, target)
      const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      writeFileSync(stampPath, JSON.stringify({ stamp, version, build: stamp.slice(0, 12) }))
    } finally {
      rmSync(temp, { force: true })
    }
    return { built: true, ms: Date.now() - start }
  }

  try {
    stamp = sourceStamp(root)
    try {
      if (existsSync(target) && JSON.parse(readFileSync(stampPath, 'utf8')).stamp === stamp) {
        return { built: false, skipped: 'up-to-date' }
      }
    } catch {
      // A missing or invalid stamp needs a fresh build.
    }

    if (opts.background) {
      const run = async () => {
        const developerDir = await new Promise<string>((resolve) => {
          if (opts.exec) {
            try {
              resolve(
                String(opts.exec('sh', xcodeArgs, { cwd: root, env: xcodeEnv, encoding: 'utf8' }))
              )
            } catch {
              resolve('')
            }
          } else {
            execFile('sh', xcodeArgs, { cwd: root, env: xcodeEnv }, (error, stdout) =>
              resolve(error ? '' : stdout)
            )
          }
        })
        const env = buildEnv(developerDir)
        if (opts.exec) opts.exec('swift', args, { cwd: root, env, stdio: 'inherit' })
        else
          await new Promise<void>((resolve, reject) => {
            const child = spawn('swift', args, { cwd: root, env, stdio: 'inherit' })
            child.once('error', reject)
            child.once('close', (code, signal) =>
              code === 0 ? resolve() : reject(new Error(`swift build exited ${code ?? signal}`))
            )
          })
        const result = finish()
        console.log(`[tc-computer] built in ${((result.ms ?? 0) / 1000).toFixed(1)}s`)
      }
      void Promise.resolve().then(run).catch((error) => fail(error, false))
      return { built: false }
    }

    const exec = opts.exec ?? execFileSync
    let developerDir = ''
    try {
      developerDir = String(exec('sh', xcodeArgs, { cwd: root, env: xcodeEnv, encoding: 'utf8' }))
    } catch {
      // A Swift toolchain on PATH can still build without an Xcode selection.
    }
    exec('swift', args, { cwd: root, env: buildEnv(developerDir), stdio: 'inherit' })
    return finish()
  } catch (error) {
    return fail(error)
  }
}
