/**
 * Dev-only render tallies by component. A component calls `tallyRender(id)`
 * at the top of its body; `__app.renders()` in the dev:prod console reads
 * the map (lib/appFacade.ts), and so does a dom test. Clicking something
 * that changes nothing must leave every count where it was.
 *
 * Kept apart from appFacade.ts so a leaf component can import it without
 * pulling the session store behind it.
 */
export const devRenders: Record<string, number> = {}

export function tallyRender(id: string): void {
  if (!import.meta.env.DEV) return
  devRenders[id] = (devRenders[id] ?? 0) + 1
}
