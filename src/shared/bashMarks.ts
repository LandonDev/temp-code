/**
 * The marks a guarded Bash call carries (src/main/server/processGuard.ts):
 * the thread and the call exported ahead of the command, so the host can
 * end, sweep and weigh every process of the call. Shared so the renderer
 * shows a command as the model wrote it, never with the marks.
 */

export const THREAD_MARK = 'TEMP_CODE_THREAD'
export const CALL_MARK = 'TEMP_CODE_CALL'

const WRAP_PREFIX = new RegExp(`^export ${THREAD_MARK}='(?:[^']|'\\\\'')*' ${CALL_MARK}='(?:[^']|'\\\\'')*'; `)

/** The command as the model wrote it (the approval card and the Activity row show this, never the marks). */
export function unwrapBashCommand(command: string): string {
  return command.replace(WRAP_PREFIX, '')
}
