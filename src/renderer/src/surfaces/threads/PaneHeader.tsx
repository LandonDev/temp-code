/** The 36px header bar every board pane wears. */
export function PaneHeader({
  label,
  detail,
  children,
  className = "",
}: {
  label: string;
  detail?: string | null;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex h-9 shrink-0 items-center justify-between border-b border-content/10 pr-2 pl-4 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-content/50 uppercase">
          {label}
        </span>
        {detail ? (
          <span className="truncate text-[11px] tabular-nums text-content/40">{detail}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
