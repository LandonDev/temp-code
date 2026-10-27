import type { SidebarLayout } from "../lib/appearance";

/** The rail is deck only: classic is retired. Callers' classic branches are
 *  dead and go when their owners next touch them; then this hook goes too. */
export function useSidebarLayout(): SidebarLayout {
  return "deck";
}
