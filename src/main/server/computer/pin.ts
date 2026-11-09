import type { AppRef } from '@shared/computer/protocol'

/**
 * A proof's seam: `TEMP_CODE_COMPUTER_PIN="TextEdit=4242[,Notes=4243]"` pins
 * an app query to a pid (case-insensitive), so an isolated instance acts on
 * its own scratch app by pid alone and never on the person's copy. Honoured
 * only with TEMP_CODE_USER_DATA (an isolated instance); a malformed entry is
 * left out.
 */
export function computerPinFromEnv(env: NodeJS.ProcessEnv = process.env): ((query: string) => AppRef | null) | null {
  if (!env.TEMP_CODE_USER_DATA || !env.TEMP_CODE_COMPUTER_PIN) return null
  const pins = new Map<string, number>()
  for (const entry of env.TEMP_CODE_COMPUTER_PIN.split(',')) {
    const m = /^\s*([^=]+?)\s*=\s*(\d+)\s*$/.exec(entry)
    const pid = m ? Number(m[2]) : NaN
    if (m && Number.isSafeInteger(pid) && pid > 0) pins.set(m[1].toLowerCase(), pid)
  }
  if (!pins.size) return null
  return (query) => {
    const pid = pins.get(query.trim().toLowerCase())
    return pid ? { pid } : null
  }
}
