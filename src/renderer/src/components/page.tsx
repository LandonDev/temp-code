import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./ui/item";
import { Skeleton } from "./ui/skeleton";

/** The scroller a page sits in (Settings, Accounts, Stats, and their
 *  skeletons): the stable gutter keeps the column still when the page
 *  gains a scrollbar, so a skeleton and its page land in one place. */
const PAGE_SCROLLER = "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]";

/** The column's cap: 672px for a page of settings, 1,152px for a page that
 *  is a table (Accounts), which reads across the pane's width. */
const PAGE_WIDTH = { column: "max-w-2xl", table: "max-w-6xl" } as const;

/**
 * The frame of a settings or app page: a 672px column (`width="table"`:
 * 1,152px) with a 24px inset, one title, an optional one-line description and the page's actions on the
 * title line. Sections stack 24px apart under it. A page never draws its own
 * header or section heading; it composes these.
 */
function Page({
  title,
  description,
  actions,
  width = "column",
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  width?: keyof typeof PAGE_WIDTH;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div data-slot="page" data-width={width} className={cn("mx-auto w-full p-6", PAGE_WIDTH[width], className)}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-6 tracking-[-0.01em] text-foreground">{title}</h1>
          {description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {/* The page's content width is a container, so a row can lay a wide control under its words (`PageRow` `wide`). */}
      <div className="@container/page mt-6 flex flex-col gap-6">{children}</div>
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
  ...rest
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const hasHead = Boolean(title || action);
  return (
    <section {...rest} data-slot="page-section" aria-labelledby={title ? id : undefined} className={cn("min-w-0", className)}>
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
  wide = false,
  className,
  children,
  ...rest
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  media?: ReactNode;
  /** A wide control (a text field): under 480px of page content it takes a
   *  full-width line under the title and description, its error under it. */
  wide?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  if (wide) return <WidePageRow {...rest} title={title} description={description} error={error} className={className}>{children}</WidePageRow>;
  return (
    <Item
      {...rest}
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

/**
 * A row whose control is too wide to sit beside a narrow page's words. Wide,
 * it reads as any row: the words, the error 2px under them, the control at
 * the end. Under 480px of page content the control drops to a full-width
 * line 8px under the words, and the error follows it 4px under the field, so
 * the words never thin to a word a line.
 */
function WidePageRow({
  title,
  description,
  error,
  className,
  children,
  ...rest
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & { title: ReactNode; description?: ReactNode; error?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <Item
      {...rest}
      data-slot="page-row"
      data-wide=""
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-none border-x-0 border-b-0 border-t-transparent px-0 py-3 @max-[30rem]/page:grid-cols-1 [[data-slot=page-row]+&]:border-t-border",
        className,
      )}
    >
      <ItemContent className="col-start-1 row-start-1 min-w-0">
        <ItemTitle>{title}</ItemTitle>
        {description ? <ItemDescription className="line-clamp-none">{description}</ItemDescription> : null}
      </ItemContent>
      {children ? (
        <ItemActions
          data-wide-control=""
          className={cn(
            "col-start-2 row-start-1 shrink-0 @max-[30rem]/page:col-start-1 @max-[30rem]/page:row-start-2 @max-[30rem]/page:mt-1.5",
            error ? "row-span-2 @max-[30rem]/page:row-span-1" : null,
          )}
        >
          {children}
        </ItemActions>
      ) : null}
      {error ? (
        <ItemDescription className="col-start-1 row-start-2 line-clamp-none text-destructive @max-[30rem]/page:row-start-3 @max-[30rem]/page:mt-0.5">{error}</ItemDescription>
      ) : null}
    </Item>
  );
}

/** What sits at a loading row's end, at its real size: a `Switch` (32×18),
 *  a `ChoiceSelect` (32px; it fits its value, so 160px stands for one), an `Input` (32px, 256px wide), a
 *  number field (32px, 80px wide), a small `Button` (28px) or nothing. */
type SkeletonControl = "switch" | "select" | "field" | "number" | "button" | "none";
const SKELETON_CONTROL: Record<Exclude<SkeletonControl, "none">, string> = {
  switch: "h-[18px] w-8 rounded-full",
  select: "h-8 w-40 rounded-lg",
  field: "h-8 w-64 rounded-lg",
  number: "h-8 w-20 rounded-lg",
  button: "h-7 w-20 rounded-md",
};
/** One loading row's shape: whether it has a muted description line and a
 *  16px glyph before its title, and its control; `wide` lays the control as
 *  a `wide` row does, on its own line under 480px of page content. */
type SkeletonRow = { description?: boolean; media?: boolean; control?: SkeletonControl; wide?: boolean };

/** Rows in their shape while a section's values load: each is a `PageRow`'s
 *  box (the 20px title line, 2px, the 16px description line, the control at
 *  its own size, 12px above and below, the hairline between neighbours), so
 *  nothing moves when the rows land. `rows` is a count of rows alike (the
 *  `description`, `media` and `control` given) or each row's own shape. */
function PageRowsSkeleton({
  rows = 2,
  description = false,
  media = false,
  control = "select",
}: { rows?: number | readonly SkeletonRow[] } & SkeletonRow) {
  const shapes: readonly SkeletonRow[] = typeof rows === "number" ? Array.from({ length: rows }, () => ({ description, media, control })) : rows;
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      {shapes.map((shape, i) => {
        const end = shape.control ?? control;
        return (
          <div
            key={i}
            data-slot="page-row-skeleton"
            data-control={end}
            className={cn(
              "flex items-center gap-3 border-t border-transparent py-3 [[data-slot=page-row-skeleton]+&]:border-border",
              shape.wide ? "@max-[30rem]/page:flex-wrap @max-[30rem]/page:gap-y-2" : null,
            )}
          >
            {(shape.media ?? media) ? <Skeleton className="size-4 shrink-0 rounded-sm" /> : null}
            <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", shape.wide ? "@max-[30rem]/page:basis-full" : null)}>
              <div className="flex h-5 items-center">
                <Skeleton className="h-3.5 w-32" />
              </div>
              {(shape.description ?? description) ? (
                <div className="flex h-4 items-center">
                  <Skeleton className="h-3 w-48" />
                </div>
              ) : null}
            </div>
            {end === "none" ? null : (
              <Skeleton
                data-skeleton-control
                className={cn("shrink-0", SKELETON_CONTROL[end], shape.wide ? "@max-[30rem]/page:w-full" : null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A section with nothing in it: one muted 12px line in a row's place. The
 *  section's heading is already the title, so this is never `Empty`. */
function PageEmpty({ className, children, ...rest }: ComponentPropsWithoutRef<"p">) {
  return (
    <p {...rest} data-slot="page-empty" className={cn("py-3 text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** A section's failure, where no single row owns it (a load the host did
 *  not answer, a save refused for the whole section): one red 12px line in
 *  a row's place, beside `PageEmpty`. An error a row owns is that row's
 *  `error`. Pre-wrapped, so a multi-line reason keeps its lines. */
function PageError({ className, children, ...rest }: ComponentPropsWithoutRef<"p">) {
  return (
    <p
      role="alert"
      {...rest}
      data-slot="page-error"
      className={cn("py-3 text-xs whitespace-pre-wrap text-destructive", className)}
    >
      {children}
    </p>
  );
}

export type { SkeletonControl, SkeletonRow };
export { Page, PageSection, PageRow, PageRowsSkeleton, PageEmpty, PageError, PAGE_SCROLLER, PAGE_WIDTH };
