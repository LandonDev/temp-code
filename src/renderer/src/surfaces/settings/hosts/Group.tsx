import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { PageSection } from "../../../components/page";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../../../components/ui/item";

type DataAttributes = Record<`data-${string}`, string | number | undefined>;

/**
 * The page frame's section (components/page.tsx `PageSection`: a 12px muted
 * heading, the actions at its end) carrying the `data-*` hooks the Hosts
 * page's tests and scripts/e2e-environments-ui.ts read.
 */
export function Group({
  title,
  action,
  className,
  children,
  ...data
}: { title?: ReactNode; action?: ReactNode; className?: string; children: ReactNode } & DataAttributes) {
  return (
    <div className={cn("min-w-0", className)} {...data}>
      <PageSection title={title} action={action}>
        {children}
      </PageSection>
    </div>
  );
}

/**
 * The frame's row (`PageRow`: title, a muted description, the control at the
 * end, a hairline only between neighbouring rows) with its `data-*` hooks,
 * and a description that may run to more than two lines.
 */
export function Row({
  title,
  description,
  error,
  media,
  className,
  children,
  ...data
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  media?: ReactNode;
  className?: string;
  children?: ReactNode;
} & DataAttributes) {
  return (
    <Item
      data-slot="page-row"
      className={cn("rounded-none border-x-0 border-b-0 border-t-transparent px-0 py-3 [[data-slot=page-row]+&]:border-t-border", className)}
      {...data}
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
