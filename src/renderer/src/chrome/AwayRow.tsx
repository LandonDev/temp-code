import { useEffect } from "react";
import { SWITCH_THUMB, SWITCH_TRACK } from "../components/ui/switch-track";
import { setAway, startAway, useAway } from "../lib/away";
import { cn } from "../lib/cn";
import { clockTime } from "../lib/duration";
import { Moon } from "./icons";
import { RailRow } from "./RailRow";

export const AWAY_LABEL = "Away from computer";

/** The row's hover line: what the switch does while off, since when while on. */
export function awayTooltip(enabled: boolean, at: number): string {
  return enabled && at > 0 ? `Away since ${clockTime(at)}` : "Threads decide without asking you";
}

/**
 * The rail foot's Away switch: the whole row is one switch named "Away from
 * computer", a moon, the label and a still track at its end. On, the track
 * and the moon take the warning tone and the label the foreground; off, it
 * reads muted like the foot's other rows. Only the thumb moves. The flip
 * shows at once (lib/away.ts `setAway`) and rolls back with a toast when the
 * host refuses it.
 */
export function AwayRow() {
  const { enabled, at } = useAway();
  useEffect(() => startAway(), []);
  return <AwayRowView enabled={enabled} at={at} onToggle={() => void setAway(!enabled)} />;
}

/** The row as it draws, for a state: the store's (AwayRow) or a fixture's. */
export function AwayRowView({ enabled, at, onToggle }: { enabled: boolean; at: number; onToggle: () => void }) {
  const on = enabled ? "true" : "false";
  return (
    <RailRow
      icon={Moon}
      label={AWAY_LABEL}
      checked={enabled}
      glyphClassName={enabled ? "text-warning" : undefined}
      className={enabled ? "text-foreground" : undefined}
      tooltip={awayTooltip(enabled, at)}
      onClick={onToggle}
      trailing={
        <span aria-hidden data-slot="away-track" data-on={on} className={cn(SWITCH_TRACK, "data-[on=true]:bg-warning")}>
          <span className={cn(SWITCH_THUMB, "group-data-[on=true]/switch:bg-background")} />
        </span>
      }
    />
  );
}
