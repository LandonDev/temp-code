import { useState, type ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";
import { SWITCH_ON, SWITCH_THUMB, SWITCH_TRACK } from "./switch-track";

type SwitchProps = Omit<ComponentProps<"button">, "checked" | "defaultChecked" | "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/** The one toggle for a setting: a 32×18 track, the thumb slides on a
 *  clip-path (`.t-toggle` in components.css) and grows a little on hover.
 *  The track's classes live in switch-track.ts. */
function Switch({ className, checked, defaultChecked = false, onCheckedChange, onClick, ...props }: SwitchProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const on = checked ?? uncontrolled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-slot="switch"
      data-on={on ? "true" : "false"}
      className={cn(
        SWITCH_TRACK,
        SWITCH_ON.track,
        "peer after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        setUncontrolled(!on);
        onCheckedChange?.(!on);
        onClick?.(event);
      }}
      {...props}
    >
      <span aria-hidden="true" data-slot="switch-thumb" className={cn(SWITCH_THUMB, SWITCH_ON.thumb)} />
    </button>
  );
}

export { Switch };
