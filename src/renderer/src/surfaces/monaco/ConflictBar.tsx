/** The honest escape hatch: one line, two words each, no modal. */
export function ConflictBar({
  kind,
  onReload,
  onKeep,
}: {
  kind: "external" | "deleted";
  onReload: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-content/10 bg-warning/10 px-3 text-[12px]">
      <span className="text-content/50">
        {kind === "external" ? "Changed on disk while you were typing" : "Deleted on disk"}
      </span>
      <span className="flex-1" />
      {kind === "external" ? (
        <button type="button" onClick={onReload} className="font-medium hover:underline">
          reload
        </button>
      ) : null}
      {kind === "external" ? <span className="text-content/30">·</span> : null}
      <button type="button" onClick={onKeep} className="font-medium hover:underline">
        keep mine
      </button>
    </div>
  );
}
