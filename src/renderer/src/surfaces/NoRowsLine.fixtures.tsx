import { ChatFooter } from "./threads/chatSlots";
import { NoRowsLine } from "./NoRowsLine";

export default [
  { name: "no rows", props: {} },
  { name: "the host's failure summary", props: { summary: "The provider did not answer; the turn ended before its first reply" } },
];

/**
 * The line over the docked composer at a wide pane, as SessionPane seats it:
 * `bun run ui:preview src/renderer/src/surfaces/NoRowsLine.fixtures.tsx#NoRowsOverComposer --width 1100`.
 * The stand-in box has the composer's edges, so the line's text should start
 * on the box's left edge at any width.
 */
export function NoRowsOverComposer() {
  return (
    <div className="flex h-64 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NoRowsLine />
      </div>
      <ChatFooter
        slots={{ transcript: null, strip: null, composer: <div className="h-[46px] rounded-xl border border-border bg-card" /> }}
      />
    </div>
  );
}
