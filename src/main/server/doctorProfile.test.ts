import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { configureHostProfiler, HostProfiler, hostProfileRunning, profileHost } from './doctorProfile'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doctor-profile-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('HostProfiler', () => {
  it('captures the requested duration and writes a profile the summary script can read', async () => {
    const profiler = new HostProfiler(dir)
    const start = performance.now()
    const result = await profiler.profile({ seconds: 1, intervalUs: 10_000 })
    expect(performance.now() - start).toBeGreaterThanOrEqual(1000)
    expect(result.seconds).toBe(1)
    expect(existsSync(result.path)).toBe(true)
    expect(result.path).toMatch(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z\.cpuprofile$/)
    expect(result.bytes).toBe(statSync(result.path).size)
    const profile = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(profile.nodes.length).toBeGreaterThan(0)
    expect(profile.samples.length).toBeGreaterThan(0)
    expect(profile.samples.length).toBe(result.samples)
    expect((profile.endTime - profile.startTime) / 1e6).toBeGreaterThanOrEqual(0.99)
    expect(profiler.running()).toBe(false)
    const summary = execFileSync('bun', ['scripts/profile-summary.ts', result.path], { encoding: 'utf8' })
    expect(summary).toContain('Top 30 by self time')
    expect(summary).toContain('Top 15 by total time')
    // Keep an optional proof artifact outside the worktree for a manual CLI run.
    if (process.env.TEMP_CODE_PROFILE_TEST_OUTPUT) copyFileSync(result.path, process.env.TEMP_CODE_PROFILE_TEST_OUTPUT)
  })

  it('refuses overlap across the shared RPC/menu profiler and other instances', async () => {
    configureHostProfiler(dir)
    const capture = profileHost({ seconds: 1, intervalUs: 10_000 })
    try {
      expect(hostProfileRunning()).toBe(true)
      await expect(profileHost({ seconds: 1 })).rejects.toThrow('a profile is running')
      await expect(new HostProfiler(dir).profile({ seconds: 1 })).rejects.toThrow('a profile is running')
    } finally {
      const result = await capture
      expect(result.path).toContain(join(dir, 'profiles'))
    }
    expect(hostProfileRunning()).toBe(false)
  })

  it('keeps the newest ten profiles and leaves other files alone', async () => {
    for (let day = 1; day <= 12; day++) {
      writeFileSync(join(dir, `2000-01-${String(day).padStart(2, '0')}T00-00-00.000Z.cpuprofile`), '{}')
    }
    writeFileSync(join(dir, 'keep.txt'), 'keep')
    const result = await new HostProfiler(dir).profile({ seconds: 1, intervalUs: 10_000 })
    const files = readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'))
    expect(files).toHaveLength(10)
    expect(existsSync(result.path)).toBe(true)
    expect(files).not.toContain('2000-01-03T00-00-00.000Z.cpuprofile')
    expect(files).toContain('2000-01-04T00-00-00.000Z.cpuprofile')
    expect(files).toContain('2000-01-12T00-00-00.000Z.cpuprofile')
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true)
  })

  it('clears the running flag after a write fails', async () => {
    const file = join(dir, 'file')
    writeFileSync(file, '')
    const profiler = new HostProfiler(file)
    await expect(profiler.profile({ seconds: 1, intervalUs: 10_000 })).rejects.toThrow()
    expect(profiler.running()).toBe(false)
    await expect(new HostProfiler(dir).profile({ seconds: 1, intervalUs: 10_000 })).resolves.toMatchObject({ seconds: 1 })
  })

  it('validates bounds and fills request defaults', async () => {
    expect(ClientRequestSchema.parse({ id: 'p', method: 'doctor.profile' })).toEqual({
      id: 'p', method: 'doctor.profile', params: { seconds: 10, intervalUs: 1000 }
    })
    for (const params of [{ seconds: 0 }, { seconds: 61 }, { intervalUs: 0 }, { intervalUs: 1.5 }]) {
      expect(ClientRequestSchema.safeParse({ id: 'p', method: 'doctor.profile', params }).success).toBe(false)
      await expect(new HostProfiler(dir).profile(params)).rejects.toThrow()
      expect(hostProfileRunning()).toBe(false)
    }
  })
})
