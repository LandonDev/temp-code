import { playCue } from "@renderer/lib/sounds";
import { Switch } from "./ui/switch";

/** A setting's switch: named for screen readers, the switch cue on a flip. */
function SettingSwitch({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      aria-label={label}
      checked={on}
      disabled={disabled}
      onCheckedChange={(next) => {
        playCue("switch");
        onChange(next);
      }}
    />
  );
}

export { SettingSwitch };
