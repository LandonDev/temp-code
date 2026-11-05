import { useMemo, useState } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { StatsBundle } from "@shared/aliaxStats";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { compact } from "@aliax/lib/viz";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { RAMP_STEPS, ramp } from "@aliax/charts/palette";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hourShort = (h: number): string => (h === 0 ? "12a" : h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`);
const hourLong = (h: number): string => (h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`);

/** The grid's height as drawn below, for the page's skeleton: the 12px hour
 *  labels, seven 16px rows 4px apart, then the ramp's 24px line 4px under it. */
export const HEATMAP_HEIGHT = 12 + 7 * 16 + 7 * 4 + 4 + 24;

/** Which ramp step a value falls in: 0 for none, else 1..RAMP_STEPS by its share of the busiest hour. */
export const stepOf = (value: number, max: number): number => (value <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * RAMP_STEPS)));

export const cellLabel = (dow: number, hour: number, value: number): string => `${DOW_FULL[dow]} ${hourLong(hour)}, ${compact(value)} output tokens`;

/**
 * Output by weekday and hour: a 7×24 grid, the hour labels in the cells' own
 * columns so each sits over the hour it names. One tooltip serves every
 * cell, drawn as every chart's readout (ChartTooltipContent): the hour,
 * then its output with the cell's swatch.
 */
export function Heatmap({ data }: { data: StatsBundle["heatmap"] }) {
  const handle = useMemo(() => TooltipPrimitive.createHandle(), []);
  const [hovered, setHovered] = useState<{ dow: number; hour: number; value: number } | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const lookup = new Map(data.map((d) => [`${d.dow}:${d.hour}`, d.value]));
  return (
    <div data-slot="heatmap" className="flex flex-col gap-1">
      <div className="grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] gap-1">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-xs leading-none text-muted-foreground tabular-nums">
            {h % 3 === 0 ? hourShort(h) : ""}
          </span>
        ))}
        {DOW.map((day, dow) => (
          <div key={day} className="contents">
            <span className="text-xs leading-4 text-muted-foreground">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const value = lookup.get(`${dow}:${hour}`) ?? 0;
              const step = stepOf(value, max);
              const label = cellLabel(dow, hour, value);
              return (
                <TooltipTrigger
                  key={hour}
                  handle={handle}
                  render={
                    <div
                      role="img"
                      aria-label={label}
                      data-step={step}
                      onPointerEnter={() => setHovered({ dow, hour, value })}
                      className={step === 0 ? "h-4 rounded-sm ring-1 ring-border ring-inset" : "h-4 rounded-sm"}
                      style={step === 0 ? undefined : { backgroundColor: ramp(step) }}
                    />
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
      <Tooltip handle={handle}>
        {/* The popup is bare: the chart readout draws the floating layer. */}
        <TooltipContent className="min-h-0 max-w-none rounded-none bg-transparent p-0 text-popover-foreground">
          {hovered ? (
            <ChartTooltipContent
              active
              label={`${DOW_FULL[hovered.dow]} ${hourLong(hovered.hour)}`}
              payload={[{ name: "Output", value: hovered.value, color: ramp(stepOf(hovered.value, max)) }]}
              valueFormatter={compact}
            />
          ) : null}
        </TooltipContent>
      </Tooltip>
      <div data-slot="heatmap-ramp" className="flex items-center justify-end gap-1 pt-2 text-xs text-muted-foreground">
        <span>0</span>
        {Array.from({ length: RAMP_STEPS }, (_, i) => (
          <span key={i} aria-hidden data-ramp className="size-2 rounded-sm" style={{ backgroundColor: ramp(i + 1) }} />
        ))}
        <span className="tabular-nums">{compact(max)}</span>
      </div>
    </div>
  );
}
