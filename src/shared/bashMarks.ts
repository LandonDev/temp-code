/**
 * The marks a guarded Bash call carries (src/main/server/processGuard.ts):
 * the thread and the call exported ahead of the command, so the host can
 * end, sweep and weigh every process of the call. Shared so the renderer
 * shows a command as the model wrote it, never with the marks.
 */

export const THREAD_MARK = 'TEMP_CODE_THREAD'
export const CALL_MARK = 'TEMP_CODE_CALL'
/** The app instance (its userData dir) that started the call: the guard's orphan sweep touches its own instance's processes alone. */
export const INSTANCE_MARK = 'TEMP_CODE_INSTANCE'

/** One single-quoted shell word, embedded quotes closed, escaped and reopened. */
const QUOTED = "'(?:[^']|'\\\\'')*'"
const WRAP_PREFIX = new RegExp(`^export ${THREAD_MARK}=${QUOTED} ${CALL_MARK}=${QUOTED}(?: ${INSTANCE_MARK}=${QUOTED})?; `)

/** The command as the model wrote it (the approval card and the Activity row show this, never the marks). */
export function unwrapBashCommand(command: string): string {
  return command.replace(WRAP_PREFIX, '')
}
