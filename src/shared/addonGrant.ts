import { z } from 'zod'
import { grantFieldNames } from './addons'
import type { AddonSpec } from './contract-addons'

/**
 * An add-on's grant: the values its `env` or `headers` name and its OAuth
 * sign-in, kept as an aliax-core profile of service `addon` (one per
 * add-on: profile name and account are the add-on's id, nickname its
 * name), never in the add-on's row. A grant of typed values is static and
 * ownerless, synced to every host as a Meta key is. An OAuth grant is
 * minted on the Mac, where the browser is, and handed to the box as its
 * owner through accountSync's two-phase handoff; the box refreshes it and
 * the Mac keeps an access copy. The aliax-core adapter mirrors this blob;
 * its fingerprint carries the `app:` prefix so accountSync reads the grant
 * as app-minted (never a CLI's own sign-in) and hands it off.
 */

export const ADDON_SERVICE = 'addon' as const

export const AddonGrantBlobSchema = z.object({
  v: z.literal(1),
  /** always 'app': the adapter's fingerprint says so to accountSync */
  mintedBy: z.literal('app'),
  addonId: z.string(),
  /** env and header values by name, typed by the person */
  fields: z.record(z.string(), z.string()),
  oauth: z
    .object({
      /** the client registered for this add-on (dynamic registration or typed), kept for every later sign-in */
      clientId: z.string(),
      clientSecret: z.string().optional(),
      /** the fixed loopback port of this add-on's redirect URI, http://127.0.0.1:<port>/callback, chosen at its first sign-in and never changed */
      redirectPort: z.number().int().min(1024).max(65535),
      authorizationUrl: z.string().url(),
      tokenUrl: z.string().url(),
      scope: z.string().optional(),
      resource: z.string().optional(),
      issuer: z.string().optional(),
      /** absent until the first sign-in completes: registered, not signed in */
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      expiresAt: z.number().int().optional()
    })
    .optional()
})
export type AddonGrantBlob = z.infer<typeof AddonGrantBlobSchema>

export const addonRedirectUri = (port: number): string => `http://127.0.0.1:${port}/callback`

/** Which names must hold a value, and whether a sign-in must have completed. */
export function grantNeeds(spec: AddonSpec): { fields: string[]; oauth: boolean } {
  return { fields: grantFieldNames(spec), oauth: spec.auth === 'oauth' }
}

/**
 * What the grant still lacks for this spec: the field names with no value,
 * then `sign-in` when an OAuth add-on has no access token yet (a client
 * registered but never signed in reads the same). Empty when it is whole;
 * the registry core's `needs-grant` detail.
 */
export function grantGaps(spec: AddonSpec, blob: AddonGrantBlob | null): string[] {
  const needs = grantNeeds(spec)
  const gaps = needs.fields.filter((name) => !blob?.fields[name])
  if (needs.oauth && !blob?.oauth?.accessToken) gaps.push('sign-in')
  return gaps
}
