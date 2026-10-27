import { stat } from 'node:fs/promises'
import type { TaskLog } from '@shared/contract'
import type { BackgroundTask } from '@shared/events'
import { readTail } from './portLog'

/**
 * One background task's output (session.taskLog), for the Activity
 * section's log fold. Claude's CLI writes a background shell's stdout and
 * stderr to `…/tasks/<taskId>.output` and names that file in the call's
 * result; portSweep.ts notes it by call. The file is tailed from an offset
 * the caller keeps (portLog.ts `readTail`). Without a file (a monitor, an
 * agent, a file the CLI already deleted) the starting call's output in the
 * transcript is the log; without that, nothing yet.
 */
export interface TaskLogDeps {
  /** The live task, when the thread still lists it (its call id). */
  task: (sessionId: string, taskId: string) => BackgroundTask | null
  fileOfCall: (callId: string) => string | null
  fileOfTask: (taskId: string) => string | null
  /** The call's tool-result output, null when it has none yet. */
  callOutput: (sessionId: string, callId: string) => string | null
}

export async function readTaskLog(
  deps: TaskLogDeps,
  sessionId: string,
  taskId: string,
  from: number | undefined
): Promise<TaskLog> {
  const callId = deps.task(sessionId, taskId)?.callId
  const file = (callId ? deps.fileOfCall(callId) : null) ?? deps.fileOfTask(taskId)
  if (file && (await stat(file).catch(() => null))?.isFile()) return { source: 'file', ...(await readTail(file, from)) }
  const output = callId ? deps.callOutput(sessionId, callId) : null
  if (output === null) return { source: 'none', data: '', next: 0 }
  const at = from === undefined || from > output.length ? 0 : from
  return { source: 'transcript', data: output.slice(at), next: output.length }
}
