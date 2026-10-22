import { Session, type Profiler } from 'node:inspector'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DoctorProfileResult } from '@shared/contract'

export interface ProfileOptions {
  seconds?: number
  intervalUs?: number
}

let capturing = false

export class HostProfiler {
  constructor(private readonly dir: string) {}

  running(): boolean {
    return capturing
  }

  async profile(opts: ProfileOptions = {}): Promise<DoctorProfileResult> {
    if (capturing) throw new Error('a profile is running')
    const { seconds = 10, intervalUs = 1000 } = opts
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
      throw new Error('seconds must be between 1 and 60')
    }
    if (!Number.isSafeInteger(intervalUs) || intervalUs <= 0) {
      throw new Error('intervalUs must be a positive integer')
    }
    capturing = true
    const session = new Session()
    let enabled = false
    try {
      session.connect()
      const post = (method: 'Profiler.enable' | 'Profiler.start' | 'Profiler.disable'): Promise<void> =>
        new Promise((resolve, reject) => session.post(method, (error) => error ? reject(error) : resolve()))
      await post('Profiler.enable')
      enabled = true
      await new Promise<void>((resolve, reject) => {
        session.post('Profiler.setSamplingInterval', { interval: intervalUs }, (error) => error ? reject(error) : resolve())
      })
      await post('Profiler.start')
      await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))
      const profile = await new Promise<Profiler.Profile>((resolve, reject) => {
        session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile))
      })
      await post('Profiler.disable')
      enabled = false
      await mkdir(this.dir, { recursive: true })
      const path = join(this.dir, `${new Date().toISOString().replace(/:/g, '-')}.cpuprofile`)
      const json = JSON.stringify(profile)
      await writeFile(path, json)
      const files = (await readdir(this.dir)).filter((name) => name.endsWith('.cpuprofile')).sort().reverse()
      await Promise.all(files.slice(10).map((name) => unlink(join(this.dir, name))))
      return { path, bytes: Buffer.byteLength(json), seconds, samples: profile.samples?.length ?? 0 }
    } finally {
      try {
        if (enabled) {
          await new Promise<void>((resolve) => session.post('Profiler.disable', () => resolve()))
        }
      } finally {
        try {
          session.disconnect()
        } finally {
          capturing = false
        }
      }
    }
  }
}

let hostProfiler: HostProfiler | null = null

export function configureHostProfiler(logDir: string): void {
  hostProfiler = new HostProfiler(join(logDir, 'profiles'))
}

export function hostProfileRunning(): boolean {
  return capturing
}

export function profileHost(opts: ProfileOptions = {}): Promise<DoctorProfileResult> {
  if (!hostProfiler) return Promise.reject(new Error('host profiler is not configured'))
  return hostProfiler.profile(opts)
}
