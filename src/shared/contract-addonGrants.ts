import { z } from 'zod'

/**
 * Add-on grants over the wire (plan-8YMm3ynnFZYs.md §7): what the Add-ons
 * settings page reads and writes about an add-on's values and its sign-in.
 * The view never carries a value, a token or a code: each field name with
 * whether this host holds a value, the OAuth state, the sign-in in flight,
 * and what the grant still lacks. Values reach a host only through
 * `addons.grant.setFields`, whose params are never logged.
 */

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const SignInStateSchema = z.enum(['discovering', 'registering', 'waiting', 'exchanging', 'failed'])
export type SignInState = z.infer<typeof SignInStateSchema>

export const AddonGrantViewSchema = z.object({
  addonId: z.string(),
  /** each value name the spec asks for, and whether this host holds one; never the value */
  fields: z.array(z.object({ name: z.string(), set: z.boolean() })),
  oauth: z
    .object({
      signedIn: z.boolean(),
      expiresAt: z.number().int().nullable(),
      /** the host that refreshes it, by name; null: this host, or nobody (no refresh token) */
      refreshedBy: z.string().nullable(),
      /** the last refresh the server refused: the person signs in again */
      refused: z.boolean()
    })
    .nullable(),
  signIn: z
    .object({
      state: SignInStateSchema,
      since: z.number().int(),
      port: z.number().int().optional(),
      error: z.string().optional()
    })
    .nullable(),
  /** grantGaps(spec, blob): the field names with no value, then 'sign-in' */
  gaps: z.array(z.string())
})
export type AddonGrantView = z.infer<typeof AddonGrantViewSchema>

/** One value: a string sets it, null (or an empty string) clears it. */
export const GrantFieldsSchema = z.record(z.string(), z.string().max(8_192).nullable())

export const AddonGrantRequestSchemas = [
  /** → { grants: AddonGrantView[] }: one per add-on row on this host with values or a sign-in */
  request('addons.grant.list', z.object({}).optional()),
  /** → { grant: AddonGrantView }: run on the grant's writer (the host that refreshes it, else the scope's home), forwarded over the admin link */
  request('addons.grant.setFields', z.object({ id: z.string(), fields: GrantFieldsSchema })),
  /** → { cleared: boolean }: run on the writer */
  request('addons.grant.clear', z.object({ id: z.string() })),
  /** → { refreshed: boolean }: the owner refreshes now (a copy met a 401); at most once per 30 s per grant */
  request('addons.grant.refresh', z.object({ id: z.string() })),
  /** → { started: true; port: number }: this host's browser; the outcome arrives by the push */
  request('addons.grant.signIn', z.object({ id: z.string() })),
  /** → { cancelled: boolean } */
  request('addons.grant.cancel', z.object({ id: z.string() }))
] as const

export const ADDON_GRANT_METHODS = ['addons.grant.list', 'addons.grant.setFields', 'addons.grant.clear', 'addons.grant.refresh', 'addons.grant.signIn', 'addons.grant.cancel'] as const
export type AddonGrantMethod = (typeof ADDON_GRANT_METHODS)[number]
export const isAddonGrantMethod = (method: string): method is AddonGrantMethod => (ADDON_GRANT_METHODS as readonly string[]).includes(method)

/** Every grant view of this host after any change (a save, a removal, a row change, a sign-in step), to every client socket. */
export type AddonGrantsPush = { push: 'addon-grants'; grants: AddonGrantView[] }
