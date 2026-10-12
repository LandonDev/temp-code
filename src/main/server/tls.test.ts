import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadTls, makeCertificate, readTlsDir } from './tls'

const root = mkdtempSync(join(tmpdir(), 'temp-code-tls-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('tls material', () => {
  it('makes a CA-signed 127.0.0.1 leaf with openssl, deletes the CA key, and reads it back', async () => {
    const dir = join(root, 'own')
    await makeCertificate(dir, 'Test Local CA')
    const m = readTlsDir(dir, 'app')
    expect(m).not.toBeNull()
    expect(m!.caPath).toBe(join(dir, 'ca.pem'))
    const leaf = new X509Certificate(m!.cert)
    expect(leaf.subject).toContain('CN=127.0.0.1')
    expect(leaf.issuer).toContain('CN=Test Local CA')
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(leaf.checkIssued(new X509Certificate(m!.cert.length ? require('node:fs').readFileSync(m!.caPath) : ''))).toBe(true)
    expect(require('node:fs').existsSync(join(dir, 'ca-key.pem'))).toBe(false)
  }, 30_000)

  it('rejects an incomplete or nearly expired directory', async () => {
    const dir = join(root, 'partial')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cert.pem'), 'x')
    expect(readTlsDir(dir, 'app')).toBeNull()
    const own = join(root, 'own')
    // 820-day leaf: valid today, "expired" seen from three years on.
    expect(readTlsDir(own, 'app', Date.now() + 3 * 365 * 86_400_000)).toBeNull()
  })

  it('loadTls prefers an Aliax pair and otherwise makes its own under dataDir', async () => {
    const aliax = join(root, 'own')
    const fromAliax = await loadTls(join(root, 'data1'), { aliaxDir: aliax })
    expect(fromAliax?.source).toBe('aliax')
    expect(fromAliax?.caPath).toBe(join(aliax, 'ca.pem'))
    const data = join(root, 'data2')
    const made = await loadTls(data, { aliaxDir: join(root, 'nowhere') })
    expect(made?.source).toBe('app')
    expect(made?.caPath).toBe(join(data, 'tls', 'ca.pem'))
    expect(new X509Certificate(require('node:fs').readFileSync(made!.caPath)).subject).toContain('TempCode Local CA')
  }, 30_000)
})
