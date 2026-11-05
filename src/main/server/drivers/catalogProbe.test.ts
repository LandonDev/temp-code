import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { seamedProbes } from './catalogProbe'

it('answers probes from TEMP_CODE_PROBED_CATALOG only on an isolated instance', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tc-probe-')), 'catalog.json')
  writeFileSync(file, JSON.stringify({ muse: { models: [{ id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', reasoning: ['low'] }], defaultModel: 'muse-wonder-full-1.0' } }))
  expect(seamedProbes({ TEMP_CODE_PROBED_CATALOG: file })).toBeNull()
  expect(seamedProbes({ TEMP_CODE_PROBED_CATALOG: file, TEMP_CODE_USER_DATA: '/tmp/x' })?.muse).toMatchObject({ defaultModel: 'muse-wonder-full-1.0' })
  expect(seamedProbes({ TEMP_CODE_USER_DATA: '/tmp/x' })).toBeNull()
})
