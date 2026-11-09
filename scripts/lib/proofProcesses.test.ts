import { expect, it } from 'vitest'
import { proofDescendants } from './proofProcesses'

it('ends detached grandchildren before their parent and excludes other app trees', () => {
  const ps = `1 0
10 1
20 10
30 20
40 10
50 1
60 50
malformed`
  expect(proofDescendants(ps, 10)).toEqual([30, 20, 40])
  expect(proofDescendants(ps, 50)).toEqual([60])
  expect(proofDescendants(ps, 99)).toEqual([])
})

it('handles an exited parent row and avoids cycles without killing its root', () => {
  expect(proofDescendants('20 10\n30 20', 10)).toEqual([30, 20])
  expect(proofDescendants('10 20\n20 10', 10)).toEqual([20])
})
