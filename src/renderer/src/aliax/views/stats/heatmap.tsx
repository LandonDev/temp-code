import { useMemo, useState } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { StatsBundle } from "@shared/aliaxStats";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { compact } from "@aliax/lib/viz";
import { RAMP_STEPS, ramp } from "@aliax/charts/palette";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hourShort = (h: number): string => (h === 0 ? "12a" : h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`);
const hourLong = (h: number): string => (h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`);

/** Which ramp step a value falls in: 0 for none, else 1..RAMP_STEPS by its share of the busiest hour. */
export const stepOf = (value: number, max: number): number => (value <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * RAMP_STEPS)));

export const cellLabel = (dow: number, hour: number, value: number): string => `${DOW_FULL[dow]} ${hourLong(hour)}, ${compact(value)} output tokens`;

/**
 * Output by weekday and hour: a 7×24 grid, the hour labels in the cells' own
 * columns so each sits over the hour it names. One tooltip serves every
 * cell; the cell under the pointer names what it shows.
 */
export function Heatmap({ data }: { data: StatsBundle["heatmap"] }) {
  const handle = useMemo(() => TooltipPrimitive.createHandle(), []);
  const [hovered, setHovered] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const lookup = new Map(data.map((d) => [`${d.dow}:${d.hour}`, d.value]));
  return (
    <div data-slot="heatmap" className="flex flex-col gap-1">
      <div className="grid grid-cols-[2rem_repeat(24,minmax(0,1fr))] gap-[3px]">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[11px] leading-none text-muted-foreground">
            {h % 3 === 0 ? hourShort(h) : ""}
          </span>
        ))}
        {DOW.map((day, dow) => (
          <div key={day} className="contents">
            <span className="text-[11px] leading-4 text-muted-foreground">{day}</span>
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
                      onPointerEnter={() => setHovered(label)}
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
        <TooltipContent>{hovered}</TooltipContent>
      </Tooltip>
      <div className="flex items-center justify-end gap-1.5 pt-2 text-[11px] text-muted-foreground">
        <span>0</span>
        {Array.from({ length: RAMP_STEPS }, (_, i) => (
          <span key={i} aria-hidden data-ramp className="size-2.5 rounded-sm" style={{ backgroundColor: ramp(i + 1) }} />
        ))}
        <span className="tabular-nums">{compact(max)}</span>
      </div>
    </div>
  );
}
