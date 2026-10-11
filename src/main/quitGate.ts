/**
 * The quit gate. A renderer that subscribed to `app:quit-requested` gets the
 * last word before the app exits (busy-session dialog, then persist, then
 * `app:confirm-quit`); until it answers, the window close handler and
 * before-quit bounce. `confirmQuit` opens the gate and ends the quit with
 * `finish()`: app.quit() normally, or whatever the updater armed for a
 * restart into a downloaded release — Electron's quitAndInstall closes every
 * window first and would otherwise sit behind the same handlers that ask the
 * renderer, which is how "Restart to update" used to do nothing.
 */
export class QuitGate {
  private quitting = false
  private pending: { finish: () => void; declined: () => void } | null = null

  constructor(private readonly defaultFinish: () => void) {}

  isQuitting(): boolean {
    return this.quitting
  }

  /** Open the gate. False when it was already open. */
  begin(): boolean {
    if (this.quitting) return false
    this.quitting = true
    return true
  }

  /** The quit did not happen after all (an armed finisher failed): close
   *  the gate so windows ask the renderer again. */
  cancel(): void {
    this.quitting = false
    this.pending = null
  }

  /** The next confirmed quit ends with `finish`; a declined dialog calls
   *  `declined` instead and disarms. */
  arm(finish: () => void, declined: () => void): void {
    this.pending = { finish, declined }
  }

  armed(): boolean {
    return this.pending !== null
  }

  /** The renderer asked the user and they said no. */
  decline(): void {
    const pending = this.pending
    this.pending = null
    pending?.declined()
  }

  /** End the quit: the armed finisher once, else the default. */
  finish(): void {
    const pending = this.pending
    this.pending = null
    ;(pending?.finish ?? this.defaultFinish)()
  }
}
