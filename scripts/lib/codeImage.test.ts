import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { CODE_ALPHABET, codeImage } from './codeImage'

it('writes a complete 1280×800 PNG with six letters from the clear alphabet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-image-'))
  try {
    const image = codeImage(join(dir, 'code.png'))
    expect(image.letters).toHaveLength(6)
    expect([...image.letters].every((c) => CODE_ALPHABET.includes(c))).toBe(true)
    expect(CODE_ALPHABET).not.toMatch(/[IL1O0S5B8Z2]/)
    const png = readFileSync(image.path)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800])
    expect(png.subarray(-12)).toEqual(Buffer.from('0000000049454e44ae426082', 'hex'))
    const length = png.readUInt32BE(33)
    const pixels = inflateSync(png.subarray(41, 41 + length))
    expect(pixels).toHaveLength((1 + 1280 * 3) * 800)
    expect(pixels.includes(0)).toBe(true)
    expect(pixels.includes(255)).toBe(true)
    expect(png.includes(Buffer.from(image.letters))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
