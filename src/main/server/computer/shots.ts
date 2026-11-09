import { copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Shot } from '@shared/computer/protocol'
import type { LandedShot } from './result'

/**
 * Pictures the service took, landed where the thread can open them
 * (`attachmentDir(thread)/computer/<n>.<ext>`, on the thread's own host), so
 * the path in the result opens with the harness's own image tool and the
 * archive and delete sweeps take them with the thread's attachments. The
 * thread's own counter names the file: the service's counter starts again
 * from 1 after the idle close prunes its directory.
 */

const pad = (n: number): string => String(n).padStart(4, '0')
const extOf = (shot: Pick<Shot, 'format'>): string => (shot.format === 'png' ? 'png' : 'jpg')

/** The next number for a thread: one above the highest in its landing dir. */
export async function nextShotNumber(landingDir: string): Promise<number> {
  const names = await readdir(landingDir).catch(() => [] as string[])
  return names.reduce((max, name) => Math.max(max, Number(/^(\d+)\.(?:jpg|png)$/.exec(name)?.[1] ?? 0)), 0) + 1
}

/** Link (else copy) the service's file to `<landing>/<n>.<ext>`, never over an existing one; the number actually used is in the path. */
export async function landShot(shot: Shot, landingDir: string, n: number, label: string, where: LandedShot['where']): Promise<LandedShot & { n: number }> {
  await mkdir(landingDir, { recursive: true })
  for (let k = n; k < n + 1_000; k++) {
    const path = join(landingDir, `${pad(k)}.${extOf(shot)}`)
    try {
      await link(shot.path, path).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') throw e
        await copyFile(shot.path, path, constants.COPYFILE_EXCL)
      })
      return { n: k, label, where, path, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg', width: shot.width, height: shot.height }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error(`no free shot name under ${landingDir}`)
}

/** The service's directory for one session: gone at the idle close and at the thread's end. */
export async function pruneServiceShots(dataDir: string, serviceSession: string): Promise<void> {
  await rm(join(dataDir, 'shots', serviceSession), { recursive: true, force: true })
}

export const STALE_SHOTS_MS = 24 * 60 * 60 * 1000

/** At boot: the service's session directories untouched for a day. */
export async function pruneStaleShots(dataDir: string, now = Date.now()): Promise<void> {
  const root = join(dataDir, 'shots')
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name)
    const info = await stat(dir).catch(() => null)
    if (info && now - info.mtimeMs > STALE_SHOTS_MS) await rm(dir, { recursive: true, force: true })
  }
}
