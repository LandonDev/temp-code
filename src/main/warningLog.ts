/**
 * Every Node warning the main process raises lands in its log with the
 * site that raised it. Node prints a warning's name and message alone, and
 * only `--trace-warnings` adds the stack, which an Electron main process
 * does not take; so a MaxListenersExceededWarning at boot named neither
 * its emitter nor its listener (V1 §2.10). Permanent and cheap: a warning
 * is rare, and the stack is the whole point.
 */
export function installWarningLog(log: (...parts: unknown[]) => void = console.warn): () => void {
  const onWarning = (warning: Error): void => {
    log('[warn]', warning.name, warning.message, '\n', warning.stack ?? '(no stack)')
  }
  process.on('warning', onWarning)
  return () => {
    process.off('warning', onWarning)
  }
}
