import type { ComponentProps } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@renderer/lib/cn";

/** The one text field: 32px, hairline border, the focus ring drawn inside
 *  (`.focus-field` in components.css). `size` is the HTML attribute. */
function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "focus-field h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] placeholder:text-muted-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
