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
