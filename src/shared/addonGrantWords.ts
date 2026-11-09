/**
 * Every line the add-on grants build says (plan-8YMm3ynnFZYs.md §9): the
 * sign-in's refusals and failures, the writer's refusals, the probe's, and
 * the sign-in's step words. The settings page and the add-on status read
 * them from here. `host` is the sign-in server's host name
 * (`new URL(issuer).host`); none of these ever carries a token, a code or a
 * value.
 */

/** The Accounts pages never manage the `addon` service. */
export const ADDON_GRANT_MANAGED = 'Add-on grants are managed on Settings → Add-ons'

export const SIGNIN_NEEDS_BROWSER = 'Sign in on the Mac: this host has no browser'
export const SIGNIN_NO_ADDRESS = (name: string): string => `${name} runs over stdio and names no address to sign in at`
export const SIGNIN_NOT_NEEDED = (name: string): string => `${name} answered without a sign-in; set its auth to none`
export const SIGNIN_NO_PKCE = (host: string): string => `${host} does not offer PKCE, so the app will not sign in to it`
export const SIGNIN_NO_REGISTRATION = (host: string): string => `${host} does not let apps register, so the app cannot sign in to it yet`
export const SIGNIN_ISSUER = (host: string): string => `${host} answered for another sign-in server`
export const SIGNIN_PORT_TAKEN = (port: number): string => `Port ${port} is in use on this Mac; close what holds it, then sign in again`
export const SIGNIN_TIMEOUT = 'The sign-in timed out after 5 minutes'
/** `error` an OAuth error code, `description` already redacted, cut and checked (oauthFlow.ts). */
export const SIGNIN_DENIED = (error: string, description?: string): string => `The sign-in was refused: ${description || error}`
export type SignInServerStep = 'discovery' | 'registration' | 'exchange'
export const SIGNIN_SERVER = (host: string, step: SignInServerStep, status: number): string => `${host} refused the ${step} (HTTP ${status})`
/** The server could not be reached at all during a step (no HTTP status to name). */
export const SIGNIN_UNREACHABLE = (host: string, step: SignInServerStep): string => `${host} could not be reached for the ${step}`
export const SIGNIN_NO_REFRESH = (host: string): string => `${host} gave no refresh token this time; remove the grant, then sign in again`
export const SIGNIN_BUSY = (name: string): string => `refused: ${name} is already signing in`
export const SIGNIN_CANCELLED = 'The sign-in was cancelled'
export const GRANT_OFFLINE = (name: string, host: string): string => `refused: grants of ${name} live on ${host}; it is offline`
export const GRANT_ON_MAC = (name: string): string => `refused: ${name}'s sign-in is still on the Mac; it moves here at the next sync`
export const GRANT_PROBE_REFUSED = 'The server refused these values'
export const GRANT_NO_ADDON = (id: string): string => `refused: no add-on ${id}`
export const GRANT_NO_FIELD = (name: string, field: string): string => `refused: ${name} takes no value named ${field}`
export const GRANT_NOT_OAUTH = (name: string): string => `refused: ${name} does not sign in`

export const SIGNIN_STEP_WORDS = {
  discovering: 'Finding the sign-in',
  registering: 'Registering the app',
  waiting: 'Waiting for the browser',
  exchanging: 'Finishing the sign-in',
  failed: 'Sign-in failed'
} as const
