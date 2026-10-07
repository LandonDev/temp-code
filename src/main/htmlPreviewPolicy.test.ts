import { describe, expect, it } from 'vitest'
import { allowRequest, isLocalAddress, isPublicHost } from './htmlPreviewPolicy'

describe('allowRequest', () => {
  it('allows the preview page, data and blob URLs, and public web hosts', () => {
    expect(allowRequest('tempcode-asset://page/preview/abc.html#tc-theme=x')).toBe(true)
    expect(allowRequest('data:image/png;base64,AAAA')).toBe(true)
    expect(allowRequest('blob:tempcode-asset://page/uuid')).toBe(true)
    expect(allowRequest('https://cdn.jsdelivr.net/npm/chart.js')).toBe(true)
    expect(allowRequest('http://example.com/a.png')).toBe(true)
    expect(allowRequest('https://8.8.8.8/x')).toBe(true)
    expect(allowRequest('https://[2606:4700::1111]/x')).toBe(true)
  })

  it('cancels files, stored pages, other schemes and malformed URLs', () => {
    expect(allowRequest('file:///etc/passwd')).toBe(false)
    expect(allowRequest('tempcode-asset://page/session-1/page.html')).toBe(false)
    expect(allowRequest('tempcode-asset://logo/x.png')).toBe(false)
    expect(allowRequest('ftp://example.com/x')).toBe(false)
    expect(allowRequest('ws://example.com/x')).toBe(false)
    expect(allowRequest('not a url')).toBe(false)
  })

  it.each([
    'http://localhost:5173/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://intranet/',
    'http://127.0.0.1:8787/',
    'http://10.1.2.3/',
    'http://172.31.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fd12::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[2002:c0a8:101::]/'
  ])('cancels local host %s', (url) => {
    expect(allowRequest(url)).toBe(false)
  })
})

describe('isLocalAddress / isPublicHost', () => {
  it('reads mapped and embedded IPv4 and keeps public addresses public', () => {
    expect(isLocalAddress('::ffff:8.8.8.8')).toBe(false)
    expect(isLocalAddress('64:ff9b::808:808')).toBe(false)
    expect(isLocalAddress('2002:808:808::')).toBe(false)
    expect(isLocalAddress('2001:db8::1')).toBe(false)
    expect(isLocalAddress('garbage')).toBe(true)
    expect(isPublicHost('Example.COM.')).toBe(true)
    expect(isPublicHost('')).toBe(false)
  })
})
