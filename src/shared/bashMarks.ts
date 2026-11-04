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

/**
 * The call's shell lowers its own priority before the command runs:
 * `renice` (CPU, nice 10) and `ionice` (idle I/O class, Linux; absent
 * elsewhere, so its failure is swallowed) on `$$`, which every process of
 * the call inherits. A batch of Maven, vitest or Fabric JVMs then never
 * starves the host's server, whose threads sit at nice 0 (or -5 with the
 * service's `Nice=`; docs/box.md). No `exec nice …`: the harness appends
 * its own cwd tracking after the command, and the command runs as written.
 */
export const NICE_LEVEL = 10
export const NICE_PRELUDE = `renice -n ${NICE_LEVEL} -p $$ >/dev/null 2>&1; ionice -c 3 -p $$ >/dev/null 2>&1; `

/** One single-quoted shell word, embedded quotes closed, escaped and reopened. */
const QUOTED = "'(?:[^']|'\\\\'')*'"
const escaped = (text: string): string => text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
const WRAP_PREFIX = new RegExp(`^export ${THREAD_MARK}=${QUOTED} ${CALL_MARK}=${QUOTED}(?: ${INSTANCE_MARK}=${QUOTED})?; (?:${escaped(NICE_PRELUDE)})?`)

/** The command as the model wrote it (the approval card and the Activity row show this, never the marks or the priority prelude). */
export function unwrapBashCommand(command: string): string {
  return command.replace(WRAP_PREFIX, '')
}
