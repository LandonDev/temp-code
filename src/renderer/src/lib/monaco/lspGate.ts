/**
 * Settings needs to nudge the LSP layer after an EULA accept without
 * importing the editor chunk: the chunk registers its retry here.
 */
let retry: (() => void) | null = null;

export function registerBlockedRetry(fn: () => void): void {
  retry = fn;
}

export function retryBlockedEnsures(): void {
  retry?.();
}
