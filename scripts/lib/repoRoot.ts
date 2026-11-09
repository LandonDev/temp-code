import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The checkout a script runs in: the first folder up from `from` holding the
 * repo's package.json. A script bundled into scripts/.out/ sits two levels
 * down, so its own file's parent is scripts/, not the root. (The computer
 * bench's rig reads it the same way.)
 */
export function repoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'temp-code') return dir
    if (dirname(dir) === dir) throw new Error(`no temp-code checkout above ${from}`)
  }
}
