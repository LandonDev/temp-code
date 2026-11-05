// A preview frame for `bun run ui:preview src/renderer/src/chrome/CommandPopover.preview.tsx#SlashMenuPreview`:
// the slash menu open above a stand-in for the composer's box.
import { CommandPopover, type PopoverMatches } from "./CommandPopover";


export function SlashMenuPreview({ matches, active }: { matches: PopoverMatches; active: number }) {
  // The preview's jsdom has no scrollIntoView, which the active row's effect calls.
  const element = document.defaultView?.Element;
  if (element && !element.prototype.scrollIntoView) element.prototype.scrollIntoView = () => {};
  return (
    <div className="flex w-[560px] flex-col justify-end" style={{ height: 360 }}>
      <div className="relative">
        <CommandPopover matches={matches} active={active} projectId={null} projects={[]} onActive={() => {}} onAccept={() => {}} />
        <div className="h-[46px] rounded-xl border border-border bg-card px-3 py-3 text-[14px] leading-[22px]">/re</div>
      </div>
    </div>
  );
}
