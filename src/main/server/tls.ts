import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * The certificate the gateway's HTTPS listeners present. Codex 0.158+
 * refuses a plain-http `chatgpt_base_url`, so every codex child talks TLS
 * to a loopback port, trusting the CA through CODEX_CA_CERTIFICATE (no
 * Keychain trust needed for the app's own children).
 *
 * Aliax already keeps such a pair in ~/.aliax/tls ("Aliax Local CA", a
 * 127.0.0.1/localhost leaf; the user trusted that CA in Keychain for the
 * shim), so it is reused when present and still valid. Without an Aliax
 * install the app makes its own under <dataDir>/tls the same way: a local
 * CA signs the leaf once, then the CA key is deleted, so the CA can never
 * vouch for anything else. A lapsed leaf means a new pair.
 */
export interface TlsMaterial {
  cert: Buffer
  key: Buffer
  /** The CA to hand children (CODEX_CA_CERTIFICATE). */
  caPath: string
  /** Where the pair came from; the app's own pair needs a one-time trust note. */
  source: 'aliax' | 'app'
}

export const ALIAX_TLS_DIR = join(homedir(), '.aliax', 'tls')
const OPENSSL = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'].find(existsSync) ?? 'openssl'
const RENEW_WITHIN_MS = 7 * 86_400_000

/** A readable, unexpired (for at least a week) cert/key/ca trio in `dir`, else null. */
export function readTlsDir(dir: string, source: TlsMaterial['source'], now = Date.now()): TlsMaterial | null {
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  const caPath = join(dir, 'ca.pem')
  if (!existsSync(certPath) || !existsSync(keyPath) || !existsSync(caPath)) return null
  try {
    const cert = readFileSync(certPath)
    const x509 = new X509Certificate(cert)
    if (new Date(x509.validTo).getTime() - now < RENEW_WITHIN_MS) return null
    return { cert, key: readFileSync(keyPath), caPath, source }
  } catch {
    return null
  }
}

/**
 * Aliax's pair when it is there, else the app's own (made on first use).
 * Null only when openssl is missing or fails: the gateway then serves
 * plain http alone and codex 0.158+ cannot be routed.
 */
export async function loadTls(dataDir: string, deps: { aliaxDir?: string } = {}): Promise<TlsMaterial | null> {
  const aliax = readTlsDir(deps.aliaxDir ?? ALIAX_TLS_DIR, 'aliax')
  if (aliax) return aliax
  const dir = join(dataDir, 'tls')
  const own = readTlsDir(dir, 'app')
  if (own) return own
  await makeCertificate(dir, 'TempCode Local CA')
  return readTlsDir(dir, 'app')
}

/** Aliax's recipe: an EC local CA (10 years) signs a 127.0.0.1/localhost leaf (820 days, under macOS's 825 cap). */
export async function makeCertificate(dir: string, caName: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const at = (name: string): string => join(dir, name)
  writeFileSync(
    at('ca.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      `CN = ${caName}`,
      '[v3_ca]',
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      ''
    ].join('\n')
  )
  writeFileSync(
    at('leaf.ext'),
    [
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = IP:127.0.0.1, DNS:localhost',
      ''
    ].join('\n')
  )
  const ec = ['ecparam', '-name', 'prime256v1', '-genkey', '-noout']
  const run = (args: string[]): Promise<unknown> => execFileP(OPENSSL, args, { timeout: 20_000 })
  try {
    await run([...ec, '-out', at('ca-key.pem')])
    await run(['req', '-x509', '-new', '-key', at('ca-key.pem'), '-out', at('ca.pem'), '-days', '3650', '-config', at('ca.cnf')])
    await run([...ec, '-out', at('key.pem')])
    await run(['req', '-new', '-key', at('key.pem'), '-out', at('leaf.csr'), '-subj', '/CN=127.0.0.1'])
    await run(['x509', '-req', '-in', at('leaf.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca-key.pem'), '-set_serial', `0x${Date.now().toString(16)}`, '-out', at('cert.pem'), '-days', '820', '-extfile', at('leaf.ext')])
  } finally {
    for (const name of ['ca-key.pem', 'leaf.csr', 'ca.cnf', 'leaf.ext']) rmSync(at(name), { force: true })
  }
}

/** The one-time Keychain step, only for a terminal codex pointed at the app's own pair. */
export const trustHint = (caPath: string): string =>
  `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "${caPath}"`
