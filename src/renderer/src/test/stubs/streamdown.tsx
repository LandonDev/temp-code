/** `streamdown` for the dom project: markdown rendered as its source. */
import type { ReactElement, ReactNode } from 'react'

export function Streamdown({ children }: { children?: ReactNode }): ReactElement {
  return <pre data-streamdown>{children}</pre>
}
export default Streamdown
