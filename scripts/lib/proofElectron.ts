import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Use this clone's Electron directly: its npm CLI needs `node` on PATH. */
export function proofElectron(repo: string): string {
  try {
    const pkg = join(repo, 'node_modules/electron')
    const entry = readFileSync(join(pkg, 'path.txt'), 'utf8').trim()
    if (!entry) throw new Error('empty Electron path')
    const binary = join(pkg, 'dist', entry)
    accessSync(binary, constants.X_OK)
    return binary
  } catch {
    throw new Error('Electron is missing from this clone: run bun node_modules/electron/install.js')
  }
}
