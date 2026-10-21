/** `streamdown` for the dom project: markdown rendered as its source; the
 *  plugin tables are empty no-ops and no fence is ever incomplete. */
import type { ReactElement, ReactNode } from 'react'

export function Streamdown({ children }: { children?: ReactNode }): ReactElement {
  return <pre data-streamdown>{children}</pre>
}
export default Streamdown

const noop = (): void => {}
/** Any plugin name answers a no-op, so a plugin list built from these stays a list of functions. */
const plugins = (): Record<string, () => void> => new Proxy({} as Record<string, () => void>, { get: () => noop })
export const defaultRehypePlugins = plugins()
export const defaultRemarkPlugins = plugins()
export const useIsCodeFenceIncomplete = (): boolean => false
export type Components = Record<string, unknown>
