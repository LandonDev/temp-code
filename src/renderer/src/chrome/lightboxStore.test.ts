import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/tcserver/commands', () => ({ readAttachment: vi.fn() }))
import { readAttachment } from '../lib/tcserver/commands'

beforeEach(() => {
  vi.resetModules()
  vi.mocked(readAttachment).mockReset()
})

describe('the lightbox image cache', () => {
  it('evicts the least recently used data URL when its byte budget fills', async () => {
    const { imageDataFor, IMAGE_CACHE_BYTES } = await import('./lightboxStore')
    const data = 'x'.repeat(IMAGE_CACHE_BYTES / 6)
    vi.mocked(readAttachment).mockResolvedValue(data)
    await imageDataFor('host', 'a')
    await imageDataFor('host', 'b')
    await imageDataFor('host', 'c')
    await imageDataFor('host', 'a')
    await imageDataFor('host', 'd')
    expect(readAttachment).toHaveBeenCalledTimes(4)
    await imageDataFor('host', 'a')
    await imageDataFor('host', 'c')
    expect(readAttachment).toHaveBeenCalledTimes(4)
    await imageDataFor('host', 'b')
    expect(readAttachment).toHaveBeenCalledTimes(5)
  })

  it('retries rejected and null reads instead of caching failures', async () => {
    const { imageDataFor } = await import('./lightboxStore')
    vi.mocked(readAttachment).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null).mockResolvedValue('data:image/png;base64,ok')
    expect(await imageDataFor('host', 'a')).toBeNull()
    expect(await imageDataFor('host', 'a')).toBeNull()
    expect(await imageDataFor('host', 'a')).toBe('data:image/png;base64,ok')
    expect(await imageDataFor('host', 'a')).toBe('data:image/png;base64,ok')
    expect(readAttachment).toHaveBeenCalledTimes(3)
  })

  it('shares in-flight reads and leaves oversized images out of the cache', async () => {
    const { imageDataFor, IMAGE_CACHE_BYTES } = await import('./lightboxStore')
    vi.mocked(readAttachment).mockResolvedValue('x'.repeat(IMAGE_CACHE_BYTES / 2 + 1))
    const first = imageDataFor('host', 'large')
    expect(imageDataFor('host', 'large')).toBe(first)
    await first
    await imageDataFor('host', 'large')
    expect(readAttachment).toHaveBeenCalledTimes(2)
  })
})
