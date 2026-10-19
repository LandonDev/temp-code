import { describe, expect, it } from 'vitest'
import { BOX_WORK_ROOT, WORK_ROOT_SETTING, workRoot } from './workRoot'

const storeWith = (value: string | null) => ({ getSetting: (key: string) => (key === WORK_ROOT_SETTING ? value : null) })

describe('workRoot', () => {
  it('prefers the setting, then the agent host folder, then home', () => {
    const onBox = (p: string) => p === BOX_WORK_ROOT || p === '/custom'
    expect(workRoot(storeWith('/custom'), { home: '/home/x', exists: onBox, platform: 'linux' })).toMatchObject({ root: '/custom', exists: true })
    expect(workRoot(storeWith(null), { home: '/home/x', exists: onBox, platform: 'linux' })).toMatchObject({ root: BOX_WORK_ROOT, exists: true, home: '/home/x' })
    expect(workRoot(storeWith('  '), { home: '/Users/y', exists: () => false, platform: 'darwin' })).toMatchObject({ root: '/Users/y', exists: false, platform: 'darwin' })
  })
  it('reports a configured root that is missing on disk', () => {
    expect(workRoot(storeWith('/gone'), { home: '/h', exists: () => false })).toMatchObject({ root: '/gone', exists: false })
  })
})
