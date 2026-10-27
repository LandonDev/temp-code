/**
 * The first-output watchdog's error (claude.ts): a message pushed with
 * nothing back for FIRST_OUTPUT_MS. The registry (sessions.ts) reads the
 * exact text to re-queue the message once into a fresh harness; a second
 * silence on the same message leaves the row errored. Kept apart from the
 * driver so the registry never imports the SDK.
 */
export const FIRST_OUTPUT_SILENCE = 'the harness never answered the message — recovered'
/** The row a second silence leaves: HARNESS_CRASHED (failureKind.ts) reads "the harness is gone". */
export const FIRST_OUTPUT_GAVE_UP = 'the harness never answered the message twice; it was not retried — the harness is gone'
