import { useId, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../../../components/ui/item";

/**
 * A group of rows under a 12px muted heading, with the group's actions at
 * the heading's end, and one row of it. The shapes match A14's page frame
 * (components/page.tsx `PageSection`, `PageRow`) so the swap, when it lands,
 * is one import here.
 */
export function Group({
  title,
  action,
  className,
  children,
  ...rest
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | number | undefined>) {
  const id = useId();
  const hasHead = Boolean(title || action);
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("min-w-0", className)} {...rest}>
      {hasHead ? (
        <div className="flex min-h-7 items-center gap-3">
          {title ? (
            <h3 id={id} className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {title}
            </h3>
          ) : (
            <span className="flex-1" />
          )}
          {action}
        </div>
      ) : null}
      <div className={cn("flex flex-col", hasHead ? "mt-1" : null)}>{children}</div>
    </section>
  );
}

/** One row: title, a muted description under it, the control at the end; an error as a red line, never clamped. */
export function Row({
  title,
  description,
  error,
  media,
  className,
  children,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  media?: ReactNode;
  className?: string;
  children?: ReactNode;
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <Item
      size="sm"
      role="listitem"
      className={cn("rounded-none border-x-0 border-b-0 border-t-border px-0 py-2.5 first:border-t-transparent", className)}
      {...rest}
    >
      {media ? <ItemMedia>{media}</ItemMedia> : null}
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full">{title}</ItemTitle>
        {description ? <ItemDescription className="line-clamp-none">{description}</ItemDescription> : null}
        {error ? <ItemDescription className="line-clamp-none text-destructive">{error}</ItemDescription> : null}
      </ItemContent>
      {children ? <ItemActions className="shrink-0">{children}</ItemActions> : null}
    </Item>
  );
}

/** A row action that removes or stops something: a ghost button in the red, quieter than a filled one in a list. */
export const DANGER_GHOST = "text-destructive hover:bg-destructive/10 active:bg-destructive/15";
