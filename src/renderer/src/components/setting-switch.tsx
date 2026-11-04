import { useState } from "react";
import { playCue } from "@renderer/lib/sounds";
import { Switch } from "./ui/switch";

/**
 * A setting's switch: named for screen readers, the switch cue on a flip. The
 * thumb moves on the click, before the host answers; `onChange` may return a
 * promise, and when it rejects or resolves `false` (the change did not land)
 * the thumb slides back to the value the host still holds.
 */
function SettingSwitch({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  // The flip the person asked for, until the host's value catches up.
  const [shown, setShown] = useState<boolean | null>(null);
  const [held, setHeld] = useState(on);
  if (held !== on) {
    setHeld(on);
    setShown(null);
  }
  return (
    <Switch
      aria-label={label}
      checked={shown ?? on}
      disabled={disabled}
      onCheckedChange={(next) => {
        playCue("switch");
        setShown(next);
        Promise.resolve(onChange(next)).then(
          (landed) => {
            if (landed === false) setShown(null);
          },
          () => setShown(null),
        );
      }}
    />
  );
}

export { SettingSwitch };
