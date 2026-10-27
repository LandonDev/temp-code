import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@renderer/lib/cn";

type CheckboxShape = "square" | "round";

const checkboxShapes: Record<CheckboxShape, string> = { square: "rounded-[4px]", round: "rounded-full" };

/** A 16px box; the check draws itself in (`.t-check` in components.css). */
function Checkbox({ className, shape = "square", ...props }: CheckboxPrimitive.Root.Props & { shape?: CheckboxShape }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-shape={shape}
      className={cn(
        "t-check peer relative flex size-4 shrink-0 items-center justify-center border border-input bg-transparent outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
        checkboxShapes[shape],
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator keepMounted data-slot="checkbox-indicator" className="grid place-content-center text-current">
        <svg viewBox="-0.3 -0.3 11 8.6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-3">
          <path d="M1 4L3.8 7L9.4 1" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, type CheckboxShape };
