import { randomInt } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY'
const FONT = [
  '01110/10001/10001/11111/10001/10001/10001', // A
  '01111/10000/10000/10000/10000/10000/01111', // C
  '11110/10001/10001/10001/10001/10001/11110', // D
  '11111/10000/10000/11110/10000/10000/11111', // E
  '11111/10000/10000/11110/10000/10000/10000', // F
  '01111/10000/10000/10111/10001/10001/01111', // G
  '10001/10001/10001/11111/10001/10001/10001', // H
  '00111/00010/00010/00010/10010/10010/01100', // J
  '10001/10010/10100/11000/10100/10010/10001', // K
  '10001/11011/10101/10101/10001/10001/10001', // M
  '10001/11001/10101/10011/10001/10001/10001', // N
  '11110/10001/10001/11110/10000/10000/10000', // P
  '01110/10001/10001/10001/10101/10010/01101', // Q
  '11110/10001/10001/11110/10100/10010/10001', // R
  '11111/00100/00100/00100/00100/00100/00100', // T
  '10001/10001/10001/10001/10001/10001/01110', // U
  '10001/10001/10001/10001/10001/01010/00100', // V
  '10001/10001/10001/10101/10101/10101/01010', // W
  '10001/10001/01010/00100/01010/10001/10001', // X
  '10001/10001/01010/00100/00100/00100/00100' // Y
].map((glyph) => glyph.split('/'))

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Write a fresh code as pixels only. The caller keeps the answer out of the prompt. */
export function codeImage(path: string): { path: string; letters: string } {
  const letters = Array.from(
    { length: 6 },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  ).join('')
  const width = 1280,
    height = 800,
    scale = 28
  const stride = 1 + width * 3
  const pixels = Buffer.alloc(stride * height, 255)
  for (let y = 0; y < height; y++) pixels[y * stride] = 0
  const left = (width - (6 * 5 + 5 * 2) * scale) / 2
  const top = (height - 7 * scale) / 2
  for (let i = 0; i < letters.length; i++) {
    const glyph = FONT[CODE_ALPHABET.indexOf(letters[i])]
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const offset =
              (top + row * scale + dy) * stride + 1 + (left + (i * 7 + col) * scale + dx) * 3
            pixels.fill(0, offset, offset + 3)
          }
      }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
  return { path, letters }
}
