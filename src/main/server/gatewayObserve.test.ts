import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, pinProfile } from 'aliax-core'
import { observeHooks } from './gatewayObserve'

const H = 'anthropic-ratelimit-unified'
let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function setup(): { logDir: string; onObserved: ReturnType<typeof vi.fn> } {
  dir = mkdtempSync(join(tmpdir(), 'temp-code-observe-'))
  configure({
    dataDir: join(dir, 'aliax'),
    fetch: async () => {
      throw new Error('no network')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' }
  })
  return { logDir: join(dir, 'logs'), onObserved: vi.fn() }
}

describe('observeHooks', () => {
  it('feeds the pinned Claude account from unified headers and nudges the service', () => {
    const { logDir, onObserved } = setup()
    pinProfile('claude-code', 'work')
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({
      service: 'claude',
      path: '/v1/messages',
      status: 200,
      headers: new Headers({ [`${H}-status`]: 'allowed', [`${H}-5h-utilization`]: '0.25', [`${H}-5h-reset`]: '1786147200', [`${H}-7d-utilization`]: '0.6' })
    })
    const cache = JSON.parse(readFileSync(join(dir, 'aliax', 'usage-cache.json'), 'utf8'))
    expect(cache['claude-code:work'].report.windows).toEqual([
      { label: '5h', usedPercent: 25, periodMs: 5 * 3_600_000, resetsAt: 1786147200_000 },
      { label: 'Weekly', usedPercent: 60, periodMs: 7 * 86_400_000 }
    ])
    expect(onObserved).toHaveBeenCalledTimes(1)
    expect(existsSync(join(logDir, 'gateway-limits.jsonl'))).toBe(false)
  })

  it('ignores answers without windows, other services, and no pin', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers({ [`${H}-5h-utilization`]: '0.25' }) })
    pinProfile('claude-code', 'work')
    hooks.onResponse!({ service: 'codex', path: '/v1/responses', status: 200, headers: new Headers({ [`${H}-5h-utilization`]: '0.25' }) })
    hooks.onResponse!({ service: 'claude', path: '/v1/messages', status: 200, headers: new Headers({ 'request-id': 'r' }) })
    expect(onObserved).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'aliax', 'usage-cache.json'))).toBe(false)
  })

  it('logs every 429 with its limit headers and body, nothing else', () => {
    const { logDir, onObserved } = setup()
    const hooks = observeHooks({ logDir, onObserved })
    hooks.onResponse!({
      service: 'claude',
      path: '/v1/messages',
      status: 429,
      headers: new Headers({ [`${H}-status`]: 'rejected', [`${H}-reset`]: '1786147200', 'retry-after': '30', 'request-id': 'req_1', 'set-cookie': 'secret=1' }),
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"You have hit your session limit"}}'
    })
    const lines = readFileSync(join(logDir, 'gateway-limits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      service: 'claude',
      path: '/v1/messages',
      status: 429,
      headers: { [`${H}-status`]: 'rejected', [`${H}-reset`]: '1786147200', 'retry-after': '30', 'request-id': 'req_1' }
    })
    expect(lines[0].headers['set-cookie']).toBeUndefined()
    expect(lines[0].body).toContain('session limit')
    expect(typeof lines[0].ts).toBe('number')
  })
})
