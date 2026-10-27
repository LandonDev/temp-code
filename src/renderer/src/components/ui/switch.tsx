import { useState, type ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

type SwitchProps = Omit<ComponentProps<"button">, "checked" | "defaultChecked" | "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/** The one toggle for a setting: a 32×18 track, the thumb slides on a
 *  clip-path (`.t-toggle` in components.css) and grows a little on hover. */
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
        "t-toggle peer group/switch relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[on=false]:bg-input data-[on=true]:bg-primary",
        className,
      )}
      onClick={(event) => {
        setUncontrolled(!on);
        onCheckedChange?.(!on);
        onClick?.(event);
      }}
      {...props}
    >
      <span aria-hidden="true" data-slot="switch-thumb" className="t-toggle-thumb pointer-events-none ms-px block h-3.5 rounded-full bg-background group-data-[on=false]/switch:bg-foreground/80 group-data-[on=true]/switch:bg-primary-foreground" />
    </button>
  );
}

export { Switch };
