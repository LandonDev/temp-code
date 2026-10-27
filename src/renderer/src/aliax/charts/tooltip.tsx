import type { ReactNode } from "react";

type Entry = { name?: ReactNode; value?: unknown; color?: string; dataKey?: unknown; payload?: unknown };

/**
 * A chart's hover readout, drawn like the app's floating layers: the x label
 * muted, then one row per series with its swatch, name and value.
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter = (v) => String(v),
  nameFormatter,
}: {
  active?: boolean;
  payload?: readonly Entry[];
  label?: ReactNode;
  labelFormatter?: (label: ReactNode) => ReactNode;
  valueFormatter?: (value: number) => string;
  nameFormatter?: (name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((e) => typeof e.value === "number");
  if (!rows.length) return null;
  return (
    <div data-slot="chart-tooltip" className="min-w-36 rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-overlay ring-1 ring-border">
      {label !== undefined && label !== "" ? <div className="mb-1 text-muted-foreground">{labelFormatter ? labelFormatter(label) : label}</div> : null}
      {rows.map((e) => {
        const name = String(e.name ?? e.dataKey ?? "");
        return (
          <div key={name} className="flex items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: e.color }} />
            <span className="min-w-0 flex-1 truncate">{nameFormatter ? nameFormatter(name) : name}</span>
            <span className="tabular-nums">{valueFormatter(e.value as number)}</span>
          </div>
        );
      })}
    </div>
  );
}
