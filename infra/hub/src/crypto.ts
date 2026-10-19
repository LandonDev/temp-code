const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
export async function hash(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}
export async function matches(value: string, digest: string): Promise<boolean> {
  const actual = await hash(value)
  let diff = actual.length ^ digest.length
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (digest.charCodeAt(i) || 0)
  return diff === 0
}
export function token(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Missing WEBHOOK_KEY')
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
}
export async function seal(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await encryptionKey(secret),
      encoder.encode(value)
    )
  )
  return btoa(String.fromCharCode(...iv, ...encrypted))
}
export async function unseal(value: string, secret: string): Promise<string> {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await encryptionKey(secret),
      bytes.slice(12)
    )
  )
}
export async function signature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
}
