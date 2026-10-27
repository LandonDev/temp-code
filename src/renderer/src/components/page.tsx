import { useId, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./ui/item";

/**
 * The frame of a settings or app page: a 672px column with a 24px inset,
 * one title, an optional one-line description and the page's actions on the
 * title line. Sections stack 24px apart under it. A page never draws its own
 * header or section heading; it composes these.
 */
function Page({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-slot="page" className={cn("mx-auto w-full max-w-2xl p-6", className)}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-tight tracking-[-0.01em] text-foreground">{title}</h1>
          {description ? <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}

/**
 * A group of rows, labelled by a 12px muted heading. `action` is one ghost
 * small button at the heading's end (Reset, Remove override). Sections are
 * told apart by space, never by a box.
 */
function PageSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const hasHead = Boolean(title || action);
  return (
    <section data-slot="page-section" aria-labelledby={title ? id : undefined} className={cn("min-w-0", className)}>
      {hasHead ? (
        // A 20px line, so the heading sits closer to its rows than to the
        // section above; a small action button overhangs it evenly.
        <div className="flex h-5 items-center gap-3 [&>[data-slot=button]]:-my-1">
          {title ? (
            <h2 id={id} className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {title}
            </h2>
          ) : (
            <span className="flex-1" />
          )}
          {action}
        </div>
      ) : null}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      <div className={cn("flex flex-col", hasHead || description ? "mt-2" : null)}>{children}</div>
    </section>
  );
}

/**
 * One setting: media, title, a muted description under it, the control at
 * the end. A hairline sits above a row that follows another row, so the
 * first row of a section, or the first after a heading, has none.
 * Neither the description nor `error` (a red line under it) is clamped: a
 * row's later lines (a path, a doctor's error) must stay readable.
 */
function PageRow({
  title,
  description,
  error,
  media,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  media?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Item
      data-slot="page-row"
      className={cn(
        "rounded-none border-x-0 border-b-0 border-t-transparent px-0 py-3 [[data-slot=page-row]+&]:border-t-border",
        className,
      )}
    >
      {media ? <ItemMedia>{media}</ItemMedia> : null}
      <ItemContent className="min-w-0">
        <ItemTitle>{title}</ItemTitle>
        {description ? <ItemDescription className="line-clamp-none">{description}</ItemDescription> : null}
        {error ? <ItemDescription className="line-clamp-none text-destructive">{error}</ItemDescription> : null}
      </ItemContent>
      {children ? <ItemActions className="shrink-0">{children}</ItemActions> : null}
    </Item>
  );
}

export { Page, PageSection, PageRow };
