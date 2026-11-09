import { createHash } from 'node:crypto'
import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { vault } from 'aliax-core'
import { ADDON_SERVICE, AddonGrantBlobSchema, grantGaps, type AddonGrantBlob } from '@shared/addonGrant'
import type { AddonRow, AddonSpec } from '@shared/contract-addons'
import { canonical } from '../addonStore'
import type { ResolvedGrant } from './addonWire'

/**
 * Where an add-on's grant comes from (plan section 4). Main reads it fresh
 * on every ask of the add-on host and answers the child with the resolved
 * values; nothing here caches or logs a value. The OAuth thread
 * (8YMm3ynnFZYs) implements `refresh` and keeps grants coming through this
 * interface.
 */
export interface AddonGrantSource {
  /** The add-on's grant blob on this host, or null. Read fresh on every ask; never cached here, never logged. */
  read(addonId: string): Promise<AddonGrantBlob | null>
  /** Optional: an OAuth source refreshes the access token (the box) or asks its owner (the Mac). */
  refresh?(addonId: string): Promise<void>
  /** Stop watching (the seam's file). */
  close?(): void
}

/**
 * What the server gets: env for stdio (each `env` name from `fields`,
 * `tokenEnv` from the oauth access token), headers for http (each `headers`
 * name from `fields`, Authorization from the oauth access token), or what
 * the grant still lacks (grantGaps).
 */
export function resolveGrant(spec: AddonSpec, blob: AddonGrantBlob | null): ResolvedGrant {
  const gaps = grantGaps(spec, blob)
  if (gaps.length) return { ok: false, gaps }
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const fields = blob?.fields ?? {}
  const token = spec.auth === 'oauth' ? blob?.oauth?.accessToken : undefined
  if (spec.transport === 'stdio') {
    for (const name of spec.env) if (name !== spec.tokenEnv && fields[name] !== undefined) env[name] = fields[name]
    if (spec.tokenEnv && token) env[spec.tokenEnv] = token
  } else {
    for (const name of spec.headers) if (fields[name] !== undefined) headers[name] = fields[name]
    if (token) headers.Authorization = `Bearer ${token}`
  }
  return { ok: true, env, headers, digest: createHash('sha256').update(canonical({ env, headers })).digest('hex') }
}

/** The vault: aliax-core's readSecret(ADDON_SERVICE, addonId) parsed by AddonGrantBlobSchema; null when absent or unreadable. AddonGrants reads through it. */
export const vaultGrantSource: AddonGrantSource & { readSync(addonId: string): AddonGrantBlob | null } = {
  readSync(addonId) {
    let raw: string | null
    try {
      raw = vault.readSecret(ADDON_SERVICE, addonId)
    } catch {
      console.warn(`[addons] the grant of ${addonId} could not be decrypted`)
      return null
    }
    if (raw === null) return null
    try {
      const parsed = AddonGrantBlobSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {
      // not JSON
    }
    console.warn(`[addons] the grant of ${addonId} is not a grant`)
    return null
  },
  async read(addonId) {
    return vaultGrantSource.readSync(addonId)
  }
}

/**
 * TEMP_CODE_ADDON_GRANTS=<file>, honoured only with TEMP_CODE_USER_DATA
 * (an isolated instance): JSON keyed by add-on NAME, each
 * `{ fields?: Record<string, string> }`, read on every ask; a change to the
 * file calls `onChange` (grantsChanged(null)).
 */
export function seamGrantSource(file: string, store: { get(id: string): AddonRow | null }, onChange: () => void, env: NodeJS.ProcessEnv = process.env): AddonGrantSource {
  if (!env.TEMP_CODE_USER_DATA) throw new Error('TEMP_CODE_ADDON_GRANTS is honoured only with TEMP_CODE_USER_DATA')
  const listener = (): void => onChange()
  watchFile(file, { interval: 200 }, listener)
  return {
    async read(addonId) {
      const row = store.get(addonId)
      if (!row) return null
      let all: Record<string, { fields?: Record<string, string> }>
      try {
        all = JSON.parse(readFileSync(file, 'utf8')) as typeof all
      } catch {
        return null
      }
      const entry = all[row.name]
      return entry ? { v: 1, mintedBy: 'app', addonId, fields: entry.fields ?? {} } : null
    },
    close: () => unwatchFile(file, listener)
  }
}

/** The source this process uses: the seam on an isolated instance that names a file, else the vault. */
export function grantSourceFor(store: { get(id: string): AddonRow | null }, onChange: () => void, env: NodeJS.ProcessEnv = process.env): AddonGrantSource {
  const file = env.TEMP_CODE_ADDON_GRANTS
  return file && env.TEMP_CODE_USER_DATA ? seamGrantSource(file, store, onChange, env) : vaultGrantSource
}

/** aliax.ts's onSecretSaved reaches the add-on host through this: index.ts sets it once the host runs. */
export const addonGrantHook: { current: ((addonId: string) => void) | null } = { current: null }

/** The hook for one saved secret: an add-on's grant tells the host at once. */
export function onAddonSecretSaved(service: string, name: string): void {
  if (service === ADDON_SERVICE) addonGrantHook.current?.(name)
}
