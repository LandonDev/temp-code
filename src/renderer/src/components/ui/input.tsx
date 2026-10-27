import type { ComponentProps, ReactNode } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@renderer/lib/cn";

/** The field's look without its size: a textarea or a code block that reads
 *  as a field takes this. */
const INPUT_FIELD_CLASS =
  "focus-field min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[13px] placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

/** The one text field: 32px, hairline border, the focus ring drawn inside
 *  (`.focus-field` in components.css). `size` is the HTML attribute. */
function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        INPUT_FIELD_CLASS,
        className,
      )}
      {...props}
    />
  );
}

/**
 * A field with a leading glyph and trailing actions: the search fields.
 * The group draws the border and the ring; the Input inside is bare.
 * `leading` is a glyph (16px, muted); `trailing` holds ghost icon buttons.
 */
function InputGroup({ className, leading, trailing, children, ...props }: ComponentProps<"div"> & { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "focus-field flex h-8 min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 has-[input:disabled]:opacity-50 has-[input[aria-invalid=true]]:border-destructive [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {leading ? (
        <span data-slot="input-group-leading" className="flex shrink-0 items-center text-muted-foreground">
          {leading}
        </span>
      ) : null}
      {children}
      {trailing ? (
        <span data-slot="input-group-trailing" className="-mr-1.5 flex shrink-0 items-center gap-0.5">
          {trailing}
        </span>
      ) : null}
    </div>
  );
}

/** The bare field inside an InputGroup: no border or ring of its own. */
function GroupInput({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn("h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

export { Input, InputGroup, GroupInput, INPUT_FIELD_CLASS };
