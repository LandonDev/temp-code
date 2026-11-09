import { describe, expect, it } from 'vitest'
import { requestFrameSchema } from '../../src/shared/computer/protocol'
import { intPoint } from './computerPoint'

describe('intPoint', () => {
  it('rounds both axes of a fractional centre before sending it on the wire', () => {
    const frame = { x: 400, y: 200, w: 25, h: 31 }
    const centre = [frame.x + frame.w / 2, frame.y + frame.h / 2]
    const request = (coordinate: number[]) => ({
      jsonrpc: '2.0', id: 1, method: 'action.run',
      params: {
        session: 'proof', app: { pid: 123 },
        action: { action: 'mouse_move', coordinate },
        tiers: ['process'], observe: { mode: 'none' }
      }
    })
    const schema = requestFrameSchema('action.run')
    expect(schema.safeParse(request(centre)).success).toBe(false)
    const point = intPoint(centre[0], centre[1])
    expect(point).toEqual([413, 216])
    expect(schema.safeParse(request(point)).success).toBe(true)
  })

  it('keeps integer coordinates unchanged', () => {
    expect(intPoint(412, 215)).toEqual([412, 215])
  })

  it('rounds after bounds and scale arithmetic without clamping either axis', () => {
    const frame = { x: -12.2, y: 20.3, w: 51.1 }
    const scale = 1.25
    expect(intPoint(frame.x + frame.w - 24 * scale, frame.y + 10 * scale)).toEqual([9, 33])
    expect(intPoint(-12.7, -3.2)).toEqual([-13, -3])
  })
})
