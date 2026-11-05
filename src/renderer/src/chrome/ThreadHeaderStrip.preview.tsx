import type { ComponentProps } from "react";
import { ThreadHeaderStrip } from "./ThreadHeaderStrip";

/**
 * The strip on the title bar's own tone (`bg-sidebar`, as TitleBar's header
 * paints it), for `bun run ui:preview
 * src/renderer/src/chrome/ThreadHeaderStrip.preview.tsx#ThreadHeaderStripOnBar`:
 * the scroll arrows and the cut edges' fade read against the bar they sit
 * on, never the page. Rendered by nothing in the app.
 */
export function ThreadHeaderStripOnBar(props: ComponentProps<typeof ThreadHeaderStrip>) {
  return (
    <div className="bg-sidebar">
      <ThreadHeaderStrip {...props} />
    </div>
  );
}
