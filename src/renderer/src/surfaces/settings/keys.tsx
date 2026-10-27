import { Kbd, KbdGroup } from "../../components/ui/kbd";
import { IS_MAC } from "../../lib/platform";

/** The modifier's cap: ⌘ on macOS, Ctrl elsewhere. */
export const MOD_CAP = IS_MAC ? "⌘" : "Ctrl";

/** One chord as key caps, inline in a line of text or at a row's end. */
export function Keys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <KbdGroup className={className ?? "mx-1 align-[-2px]"}>
      {keys.map((key, index) => (
        <Kbd key={`${key}-${index}`} size="sm">
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}
