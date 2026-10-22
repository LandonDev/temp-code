import { describe, expect, it } from 'vitest'
import {
  DEPLOY_STAGES,
  PUBLISH_PHASES,
  PhaseTracker,
  deployProgress,
  deployStageOf,
  formatDuration,
  parseDuration,
  parsePhaseLine
} from './releasePhases'

describe('parseDuration / formatDuration', () => {
  it('reads the script spelling, the gate spelling and the foot spelling', () => {
    expect(parseDuration('71s')).toBe(71_000)
    expect(parseDuration('4m12s')).toBe(252_000)
    expect(parseDuration('4m 12s')).toBe(252_000)
    expect(parseDuration('1.2s')).toBe(1_200)
    expect(parseDuration('1h02m')).toBe(3_720_000)
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('fast')).toBeNull()
    expect(parseDuration('12 apples')).toBeNull()
  })

  it('formats without spaces, the way the script does', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(71_400)).toBe('1m11s')
    expect(formatDuration(252_000)).toBe('4m12s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
    expect(parseDuration(formatDuration(252_000))).toBe(252_000)
  })
})

describe('parsePhaseLine', () => {
  it('reads start, end, failure, skip and total lines and nothing else', () => {
    expect(parsePhaseLine('phase › gate')).toEqual({ kind: 'start', phase: 'gate' })
    expect(parsePhaseLine('phase ✓ gate 71s')).toEqual({ kind: 'end', phase: 'gate', ok: true, ms: 71_000 })
    expect(parsePhaseLine('phase ✗ build 12s')).toEqual({ kind: 'end', phase: 'build', ok: false, ms: 12_000 })
    expect(parsePhaseLine('phase – gate skipped')).toEqual({ kind: 'skipped', phase: 'gate' })
    expect(parsePhaseLine('phase ✓ total 4m12s 1.0.283')).toEqual({ kind: 'total', ms: 252_000, version: '1.0.283' })
    expect(parsePhaseLine('  phase ✓ total 4m12s v1.0.283\r')).toEqual({ kind: 'total', ms: 252_000, version: '1.0.283' })
    expect(parsePhaseLine('phase ✓ total 4m12s')).toEqual({ kind: 'total', ms: 252_000, version: null })
    expect(parsePhaseLine('phase ✓ update')).toEqual({ kind: 'end', phase: 'update', ok: true, ms: 0 })
    expect(parsePhaseLine('== uploading')).toBeNull()
    expect(parsePhaseLine('phase: gate')).toBeNull()
    expect(parsePhaseLine('  • building        target=zip')).toBeNull()
  })
})

describe('PhaseTracker', () => {
  it('counts the phases that ended of the expected list, labels the running one, and sums the run', () => {
    const t = new PhaseTracker()
    expect(t.progress()).toEqual({ done: 0, total: PUBLISH_PHASES.length })
    t.feed('phase › gate')
    t.feed('phase › build')
    expect(t.progress()).toEqual({ done: 0, total: 8, label: 'build' })
    t.feed('  • electron-builder  version=26.0.12')
    t.feed('phase ✓ build 84s')
    expect(t.progress()).toEqual({ done: 1, total: 8 })
    t.feed('phase ✓ gate 71s')
    t.feed('phase › sign')
    expect(t.progress()).toEqual({ done: 2, total: 8, label: 'sign' })
    t.feed('phase ✓ sign 40s')
    t.feed('phase › zip')
    t.feed('phase › pack')
    t.feed('phase ✓ pack 15s')
    t.feed('phase ✓ zip 22s')
    t.feed('phase › upload')
    t.feed('phase ✓ upload 48s')
    t.feed('phase › feed')
    t.feed('phase ✓ feed 6s')
    t.feed('phase ✓ total 4m12s 1.0.283')
    expect(t.progress()).toEqual({ done: 7, total: 8 })
    expect(t.version).toBe('1.0.283')
    expect(t.totalMs).toBe(252_000)
    expect(t.summary()).toBe('gate 1m11s · build 1m24s · sign 40s · zip 22s · pack 15s · upload 48s · feed 6s')
    t.feed('phase › update')
    expect(t.progress()).toEqual({ done: 7, total: 8, label: 'update' })
    t.feed('phase ✓ update 31s')
    expect(t.progress()).toEqual({ done: 8, total: 8 })
    expect(t.times.get('update')).toBe(31_000)
  })

  it('a skipped gate counts as done, a failed phase is named in the summary, an unknown phase is kept but not counted', () => {
    const t = new PhaseTracker(['gate', 'build'])
    t.feed('phase – gate skipped')
    expect(t.progress()).toEqual({ done: 1, total: 2 })
    t.feed('phase › build')
    t.feed('phase ✗ build 12s')
    expect(t.progress()).toEqual({ done: 2, total: 2 })
    expect(t.failed.has('build')).toBe(true)
    t.feed('phase ✓ push 3s')
    expect(t.progress().done).toBe(2)
    expect(t.summary()).toBe('build 12s failed · push 3s')
  })
})

describe('deploy stages', () => {
  it('maps box-update lines onto the stage list and nothing else', () => {
    expect(deployStageOf('SOURCE: release asset temp-code-out-1.0.283.tar.gz (sha256 verified) abc')).toBe('source')
    expect(deployStageOf('TRIAL PASS: build-… port=7690 sha=abc')).toBe('trial')
    expect(deployStageOf('COMMIT: current=build-2 previous=build-1')).toBe('commit')
    expect(deployStageOf('ERROR: refused ref')).toBeNull()
    expect(deployStageOf('WARN: could not prune')).toBeNull()
    expect(deployStageOf('== box-update v1.0.283 (2026-10-21T10:00:00Z)')).toBeNull()
    expect(deployStageOf('plain output')).toBeNull()
  })

  it('counts the stages seen of the whole list with the latest as the label', () => {
    expect(deployProgress([])).toEqual({ done: 0, total: DEPLOY_STAGES.length })
    expect(deployProgress(['== box-update v1.0.283', 'SOURCE: release asset x', 'MODULES: reused from y', 'BUILD: skipped; prebuilt'])).toEqual({
      done: 3,
      total: 7,
      label: 'build'
    })
    expect(deployProgress(['SOURCE: a', 'SOURCE: b', 'TRIAL: c', 'TRIAL PASS: d']).done).toBe(2)
  })
})
