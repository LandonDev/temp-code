import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyMedia,
  fsMedia,
  insideRealRoots,
  parseRange,
  readMediaRange,
  resetMediaTokens,
  setMediaHost,
  serveMedia,
  setMediaRoots,
  sniffMedia
} from './media'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const GIF = Buffer.from('GIF89a\x10\x00\x10\x00')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)])
const EBML_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20), Buffer.from('\x42\x82\x84webm'), Buffer.alloc(8)])
const EBML_MKV = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20), Buffer.from('\x42\x82\x88matroska')])

describe('sniffMedia / classifyMedia', () => {
  it('reads the signature of every common container', () => {
    expect(sniffMedia(PNG, '')).toMatchObject({ kind: 'image', mime: 'image/png' })
    expect(sniffMedia(JPEG, '')).toMatchObject({ mime: 'image/jpeg' })
    expect(sniffMedia(GIF, '')).toMatchObject({ mime: 'image/gif' })
    expect(sniffMedia(WEBP, '')).toMatchObject({ mime: 'image/webp' })
    expect(sniffMedia(WAV, '')).toMatchObject({ kind: 'audio', mime: 'audio/wav' })
    expect(sniffMedia(ftyp('avif'), '')).toMatchObject({ mime: 'image/avif' })
    expect(sniffMedia(ftyp('heic'), '')).toMatchObject({ mime: 'image/heic' })
    expect(sniffMedia(ftyp('qt  '), '')).toMatchObject({ kind: 'video', mime: 'video/quicktime' })
    expect(sniffMedia(ftyp('isom'), '')).toMatchObject({ kind: 'video', mime: 'video/mp4' })
    expect(sniffMedia(ftyp('M4A '), '')).toMatchObject({ kind: 'audio', mime: 'audio/mp4' })
    expect(sniffMedia(ftyp('mp42'), 'm4a')).toMatchObject({ kind: 'audio', mime: 'audio/mp4' })
    expect(sniffMedia(EBML_WEBM, '')).toMatchObject({ mime: 'video/webm' })
    expect(sniffMedia(EBML_MKV, '')).toMatchObject({ mime: 'video/x-matroska' })
    expect(sniffMedia(Buffer.from('OggS\0\x02'), 'ogg')).toMatchObject({ kind: 'audio', mime: 'audio/ogg' })
    expect(sniffMedia(Buffer.from('OggS\0\x02'), 'ogv')).toMatchObject({ kind: 'video', mime: 'video/ogg' })
    expect(sniffMedia(Buffer.from('fLaC\0\0'), '')).toMatchObject({ mime: 'audio/flac' })
    expect(sniffMedia(Buffer.from('ID3\x04\0\0'), '')).toMatchObject({ mime: 'audio/mpeg' })
  })

  it('says nothing for text, short files and unknown RIFF forms', () => {
    expect(sniffMedia(Buffer.from('export const a = 1\n'), 'ts')).toBeNull()
    expect(sniffMedia(Buffer.from('GI'), '')).toBeNull()
    expect(sniffMedia(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]), 'avi')).toBeNull()
  })

  it('lets the signature win over a misleading extension, and the extension fill a silent one', () => {
    expect(classifyMedia('/p/shot.txt', PNG)).toMatchObject({ mime: 'image/png' })
    expect(classifyMedia('/p/shot', PNG)).toMatchObject({ mime: 'image/png' })
    expect(classifyMedia('/p/logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({
      kind: 'image',
      mime: 'image/svg+xml'
    })
    expect(classifyMedia('/p/icon.ICO', Buffer.from([0, 0, 1, 0, 1, 0]))).toMatchObject({ mime: 'image/x-icon' })
    expect(classifyMedia('/p/pic.bmp', Buffer.from('BM\0\0\0\0'))).toMatchObject({ mime: 'image/bmp' })
    expect(classifyMedia('/p/clip.MP3', Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toMatchObject({ mime: 'audio/mpeg' })
    expect(classifyMedia('/p/clip.mkv', Buffer.alloc(0))).toMatchObject({ mime: 'video/x-matroska' })
  })

  it('leaves code, markup and other binaries to the text path', () => {
    expect(classifyMedia('/p/index.html', Buffer.from('<svg></svg>'))).toBeNull()
    expect(classifyMedia('/p/a.ts', Buffer.from('const x = 1'))).toBeNull()
    expect(classifyMedia('/p/a.zip', Buffer.from('PK\x03\x04'))).toBeNull()
    expect(classifyMedia('/p/a.pdf', Buffer.from('%PDF-1.7'))).toBeNull()
    expect(classifyMedia('/p/a.wasm', Buffer.from('\0asm'))).toBeNull()
  })
})

describe('parseRange', () => {
  it('maps the three bytes= forms onto a file and clamps the tail', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('refuses what cannot be satisfied and ignores what it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
  })
})

describe('the file host', () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'tc-media-root-')))
    outside = await realpath(await mkdtemp(join(tmpdir(), 'tc-media-out-')))
    await mkdir(join(root, 'img'))
    await writeFile(join(root, 'img', 'a.png'), Buffer.concat([PNG, Buffer.alloc(84, 7)]))
    await writeFile(join(outside, 'secret.png'), Buffer.concat([PNG, Buffer.alloc(16)]))
    await writeFile(join(root, 'notes.md'), '# hi\n')
    await symlink(join(outside, 'secret.png'), join(root, 'img', 'link.png'))
    setMediaRoots(() => [root])
    resetMediaTokens()
  })

  afterEach(async () => {
    setMediaRoots(() => [])
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('describes media inside a root with a token URL and no path', async () => {
    const media = await fsMedia(join(root, 'img', 'a.png'))
    expect(media).toMatchObject({ kind: 'image', mime: 'image/png', size: 100 })
    expect(media!.url).toMatch(/^tempcode-asset:\/\/file\/[a-f0-9]{32}\/a\.png\?v=\d+$/)
    expect(media!.url).not.toContain(root)
    // Same file, same token: the renderer's cache key stays stable.
    expect((await fsMedia(join(root, 'img', 'a.png')))!.url).toBe(media!.url)
  })

  it('answers null for text, for media outside every root, and for a symlink that points out', async () => {
    expect(await fsMedia(join(root, 'notes.md'))).toBeNull()
    expect(await fsMedia(join(outside, 'secret.png'))).toBeNull()
    expect(await fsMedia(join(root, 'img', 'link.png'))).toBeNull()
    expect(await fsMedia(join(root, 'img', 'missing.png'))).toBeNull()
  })

  it('refuses a root spelled as a prefix of another directory', () => {
    expect(insideRealRoots(`${root}-other/x.png`, [root])).toBe(false)
    expect(insideRealRoots(join(root, 'x.png'), [root])).toBe(true)
    expect(insideRealRoots(root, [root])).toBe(true)
  })

  it('streams the whole file with the headers a <video> needs', async () => {
    const { url } = (await fsMedia(join(root, 'img', 'a.png')))!
    const res = serveMedia(new Request(url))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Length')).toBe('100')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.concat([PNG, Buffer.alloc(84, 7)]))
  })

  it('answers a Range with 206 and exactly those bytes, and 416 past the end', async () => {
    const { url } = (await fsMedia(join(root, 'img', 'a.png')))!
    const part = serveMedia(new Request(url, { headers: { Range: 'bytes=4-7' } }))
    expect(part.status).toBe(206)
    expect(part.headers.get('Content-Range')).toBe('bytes 4-7/100')
    expect(part.headers.get('Content-Length')).toBe('4')
    expect(Buffer.from(await part.arrayBuffer())).toEqual(PNG.subarray(4, 8))
    const tail = serveMedia(new Request(url, { headers: { Range: 'bytes=-3' } }))
    expect(tail.headers.get('Content-Range')).toBe('bytes 97-99/100')
    const past = serveMedia(new Request(url, { headers: { Range: 'bytes=100-' } }))
    expect(past.status).toBe(416)
    expect(past.headers.get('Content-Range')).toBe('bytes */100')
    const head = serveMedia(new Request(url, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
  })

  it('names this host on the URL once it knows its id, so another host reads from here', async () => {
    setMediaHost('env_box')
    try {
      const { url } = (await fsMedia(join(root, 'img', 'a.png')))!
      expect(url).toMatch(/^tempcode-asset:\/\/file\/[a-f0-9]{32}\/a\.png\?v=\d+&host=env_box$/)
      expect(serveMedia(new Request(url)).status).toBe(200)
    } finally {
      setMediaHost('')
    }
  })

  it('answers media.read in capped ranges by token, with the size, and nothing for a token it never minted', async () => {
    const { url } = (await fsMedia(join(root, 'img', 'a.png')))!
    const token = /file\/([a-f0-9]{32})\//.exec(url)![1]
    const whole = (await readMediaRange(token, 0, 1 << 20))!
    expect(whole).toMatchObject({ mime: 'image/png', size: 100 })
    expect(Buffer.from(whole.dataBase64, 'base64')).toEqual(Buffer.concat([PNG, Buffer.alloc(84, 7)]))
    const part = (await readMediaRange(token, 4, 4))!
    expect(Buffer.from(part.dataBase64, 'base64')).toEqual(PNG.subarray(4, 8))
    const tail = (await readMediaRange(token, 98, 10))!
    expect(Buffer.from(tail.dataBase64, 'base64').length).toBe(2)
    expect(await readMediaRange('00000000000000000000000000000000', 0, 1)).toBeNull()
    setMediaRoots(() => [])
    expect(await readMediaRange(token, 0, 1)).toBeNull()
    setMediaRoots(() => [root])
  })

  it('serves nothing for an unknown token, a path it never minted, or a file that left the fence', async () => {
    expect(serveMedia(new Request('tempcode-asset://file/00000000000000000000000000000000/a.png')).status).toBe(404)
    expect(serveMedia(new Request(`tempcode-asset://file/${encodeURIComponent(root)}/img/a.png`)).status).toBe(404)
    const { url } = (await fsMedia(join(root, 'img', 'a.png')))!
    // The project is closed: the token outlives the root but the fence does not.
    setMediaRoots(() => [])
    expect(serveMedia(new Request(url)).status).toBe(403)
    setMediaRoots(() => [root])
    // The file is swapped for a symlink out of the root after the token was minted.
    await rm(join(root, 'img', 'a.png'))
    await symlink(join(outside, 'secret.png'), join(root, 'img', 'a.png'))
    expect(serveMedia(new Request(url)).status).toBe(403)
  })
})
