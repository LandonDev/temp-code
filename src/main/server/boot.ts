import { appendFileSync } from 'node:fs'

/** Boot timing trail: `/tmp/temp-code-boot.log` (beside the release
 *  worker's log) plus the console. Each line is milliseconds since the
 *  process started, so a slow startup shows exactly which step ate it. */
export const BOOT_LOG = '/tmp/temp-code-boot.log'

export function bootMark(label: string, detail?: string): void {
  const ms = Math.round(process.uptime() * 1000)
  const line = `${ms} ${label}${detail ? ` ${detail}` : ''}`
  console.log(`[boot] ${line}`)
  try {
    appendFileSync(BOOT_LOG, `${line}\n`)
  } catch {
    // timing evidence, never a failure
  }
}
