/**
 * The renderer soak's window (scripts/measure-renderer-soak.ts): with
 * TEMP_CODE_SOAK_WINDOW=1 on an isolated instance (TEMP_CODE_USER_DATA) the
 * window shows inactive, so a soak during a publish never takes the
 * person's focus, and Chromium neither throttles its timers nor stops
 * painting it behind other windows, so a hidden window measures what a
 * visible one costs. Never honoured without TEMP_CODE_USER_DATA: the
 * installed app always throttles a window nobody sees.
 */
export function soakWindow(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TEMP_CODE_USER_DATA && env.TEMP_CODE_SOAK_WINDOW === '1'
}

/** Chromium's switches for an unthrottled window behind others. */
export const SOAK_SWITCHES = ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding'] as const
