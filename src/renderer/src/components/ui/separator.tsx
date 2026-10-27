import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@renderer/lib/cn";

/** A hairline. Use spacing first; a separator only where spacing alone
 *  would not tell two groups apart. */
function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn("shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch", className)}
      {...props}
    />
  );
}

export { Separator };
