import { describe, expect, it } from 'vitest'
import { forwardedLine, macUrl } from './contract-ports'

const forward = (macPort: number | null, error: string | null = null, hostName = 'Mac', environmentId = 'env_mac') => ({ environmentId, hostName, macPort, error })

describe('forwardedLine', () => {
  it('says nothing with no forward or one still pending, why a forward failed, and the Mac URL once bound', () => {
    expect(forwardedLine(5173, [])).toBeNull()
    expect(forwardedLine(5173, [forward(null)])).toBeNull()
    expect(forwardedLine(5173, [forward(null, 'no free port from 5173 to 5273')])).toBe('Port 5173 was not forwarded to the Mac: no free port from 5173 to 5273')
    expect(forwardedLine(5173, [forward(5174)])).toBe('Forwarded to http://localhost:5174 on the Mac (5173 is taken there)')
    expect(forwardedLine(5173, [forward(5173)])).toBe('Forwarded to http://localhost:5173 on the Mac')
    // Two Macs: each named, a pending one left out.
    expect(forwardedLine(5173, [forward(5173, null, 'Studio', 'env_a'), forward(5180, null, 'Air', 'env_b'), forward(null, null, 'Mini', 'env_c')])).toBe(
      'Forwarded to http://localhost:5173 on Studio\nForwarded to http://localhost:5180 on Air (5173 is taken there)'
    )
    expect(macUrl(5174)).toBe('http://localhost:5174')
  })
})
