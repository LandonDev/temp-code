import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('blocks a direct Node fetch before DNS and allows loopback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-gate-network-test-'))
  const denied = join(root, 'denied.log')
  const server = createServer((_req, res) => res.end('local response'))
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as { port: number }).port
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--require',
        resolve('scripts/lib/skillsDriversNetwork.cjs'),
        '-e',
        `fetch('http://127.0.0.1:${port}').then(r=>r.text()).then(console.log).then(()=>fetch('https://example.invalid')).catch(()=>console.log('blocked'))`
      ],
      { env: { ...process.env, TEMP_CODE_GATE_DENIED: denied } }
    )
    expect(stdout).toContain('local response')
    expect(stdout).toContain('blocked')
    expect(readFileSync(denied, 'utf8')).toContain('connect example.invalid:443')
  } finally {
    server.closeAllConnections()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
