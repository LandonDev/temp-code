// The dock badge's rules, apart from Electron so a test can hold them.

/** Every window reports the same hosts, so the dock shows the largest
 *  report, never their sum. */
export function badgeText(reports: number[]): string {
  const n = reports.reduce((max, r) => Math.max(max, r), 0)
  return n <= 0 ? '' : n > 99 ? '99+' : String(n)
}

/** Bounce once when the count rises while no app window is focused. */
export function shouldBounce(prev: number, next: number, anyFocused: boolean): boolean {
  return next > prev && !anyFocused
}
