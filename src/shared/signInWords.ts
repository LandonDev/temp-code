// Every line a Claude sign-in sends to the Accounts page, in one place.
// The page shows nothing for CANCELLED; any other error is the sign-in
// dialog's one red line, and the notes ride the success.

/** The window closed, or Cancel: the person chose it, so nothing is said. */
export const CANCELLED = 'cancelled'
export const UNREACHABLE = "Couldn't reach claude.ai"
export const NO_ANSWER = "claude.ai didn't answer"
export const NO_ACCOUNT = "Claude's answer named no account"

export function exchangeRefused(status: number): string {
  return `Claude refused the sign-in (HTTP ${status})`
}

/** The note of a sign-in to an account already saved; the page toasts "Updated <name>" for it. */
export const SIGN_IN_REFRESHED = 'Sign-in refreshed'

/** Both halves captured and a new account: nothing to say. */
export function signInNotes(input: { hasSession: boolean; alreadySaved: boolean }): string[] {
  return [
    input.hasSession ? '' : 'Saved without its claude.ai session',
    input.alreadySaved ? SIGN_IN_REFRESHED : ''
  ].filter(Boolean)
}

export function cliRepairNote(result: { ok: boolean; error?: string }): string {
  return result.ok ? 'CLI sign-in repaired' : `The CLI's sign-in is still expired (${result.error ?? 'unknown error'})`
}

/**
 * What a fresh Claude sign-in does to the CLI's own: `install` when the CLI
 * is signed in nowhere (a first run: without it the next send still reads
 * "Not logged in"), `repair` when it is on this account and its sign-in is
 * dead, else nothing (never a switch away from another live account, and
 * never while sign-ins are handed to another host).
 */
export function cliTakesSignIn(input: {
  handedOff: boolean
  /** The CLI holds a sign-in, or reading it failed (taken as yes). */
  liveSignedIn: boolean
  sameAccount: boolean
  liveExpired: boolean
}): 'install' | 'repair' | null {
  if (input.handedOff) return null
  if (!input.liveSignedIn) return 'install'
  return input.sameAccount && input.liveExpired ? 'repair' : null
}

export function cliInstallNote(result: { ok: boolean; error?: string }): string | null {
  return result.ok ? null : `The CLI is still signed out (${result.error ?? 'unknown error'})`
}

/** Whether the CLI's credential store holds a grant: absent is no, and a
 *  read that fails is yes, so a locked store never reads as signed out. */
export function holdsGrant(read: () => Promise<string | null>): Promise<boolean> {
  return read().then(
    (value) => value !== null,
    () => true
  )
}
