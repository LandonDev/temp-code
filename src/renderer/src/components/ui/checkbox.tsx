import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@renderer/lib/cn";
import { CHECKBOX_BOX, CHECKBOX_INDICATOR, CHECKBOX_SHAPES, CheckMark, type CheckboxShape } from "./checkbox-box";

/** A 16px box; the check draws itself in (`.t-check` in components.css). */
function Checkbox({ className, shape = "square", ...props }: CheckboxPrimitive.Root.Props & { shape?: CheckboxShape }) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" data-shape={shape} className={cn(CHECKBOX_BOX, CHECKBOX_SHAPES[shape], className)} {...props}>
      <CheckboxPrimitive.Indicator keepMounted data-slot="checkbox-indicator" className={CHECKBOX_INDICATOR}>
        <CheckMark />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, type CheckboxShape };
