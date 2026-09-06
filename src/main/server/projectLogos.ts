import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function stem(projectPath: string): string {
  const key = projectPath.trim() || 'project'
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120)
  // Distinguish paths whose slashes and punctuation sanitize alike.
  return `${safe}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

export class ProjectLogos {
  private pending = new Map<string, Promise<unknown>>()
  private dir: string
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'project-logos')
  }

  private async serial<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
    const key = stem(projectPath)
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
    this.pending.set(key, next)
    try {
      return await next
    } finally {
      if (this.pending.get(key) === next) this.pending.delete(key)
    }
  }

  private async removeFiles(projectPath: string, except?: string): Promise<void> {
    const prefix = `${stem(projectPath)}.`
    for (const name of await readdir(this.dir)) {
      if (name.startsWith(prefix) && name !== except) await rm(join(this.dir, name))
    }
  }

  save(projectPath: string, sourcePath: string): Promise<string> {
    return this.serial(projectPath, async () => {
      const source = sourcePath.startsWith('~/') ? join(homedir(), sourcePath.slice(2)) : sourcePath
      const ext = extname(source).toLowerCase()
      if (!extensions.has(ext)) throw new Error('Logo must be a PNG, JPG, GIF, WebP, or SVG image')
      const file = await open(source, 'r')
      let bytes: Buffer
      try {
        const meta = await file.stat()
        if (!meta.isFile()) throw new Error('Not a file')
        if (meta.size > MAX_BYTES) throw new Error('Logo is too large (maximum 2 MB)')
        const buffer = Buffer.alloc(MAX_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > MAX_BYTES) throw new Error('Logo is too large (maximum 2 MB)')
        bytes = buffer.subarray(0, length)
      } finally {
        await file.close()
      }
      await mkdir(this.dir, { recursive: true })
      const name = `${stem(projectPath)}${ext}`
      const dest = join(this.dir, name)
      const temp = join(this.dir, `.${stem(projectPath)}-${randomUUID()}-upload`)
      try {
        const upload = await open(temp, 'wx', 0o600)
        try {
          await upload.writeFile(bytes)
        } finally {
          await upload.close()
        }
        await rename(temp, dest)
        await this.removeFiles(projectPath, name)
      } finally {
        await rm(temp, { force: true })
      }
      return dest
    })
  }

  remove(projectPath: string): Promise<void> {
    return this.serial(projectPath, async () => {
      await mkdir(this.dir, { recursive: true })
      await this.removeFiles(projectPath)
    })
  }
}
