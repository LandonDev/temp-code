import { openUrl, useCallPortOpen } from "../lib/devPorts";

/**
 * A shell call that opened a dev server (docs/box.md "Dev servers on the
 * box"): its row ends with where it opens here. "Open on the Mac" for a box
 * thread's server forwarded to this Mac, "Open in browser" for one of this
 * Mac's own; the number after it is the one this Mac serves it on, so a
 * forward that moved past a taken port says which.
 */
export function CallPortLink({ callId }: { callId: string | undefined }) {
  const open = useCallPortOpen(callId);
  if (!open) return null;
  return (
    <button
      type="button"
      data-call-port={open.port}
      title={open.movedFrom ? `${open.url} · ${open.movedFrom} is taken here` : open.url}
      onClick={(e) => {
        e.stopPropagation();
        openUrl(open.url);
      }}
      className="pressable shrink-0 rounded-[5px] px-1 text-[12px] text-content/55 hover:bg-content/8 hover:text-content"
    >
      {open.label}
      <span className="ml-1 tabular-nums text-content/40">:{open.port}</span>
    </button>
  );
}
