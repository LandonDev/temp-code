import { cn } from '../../lib/utils'

/**
 * The settings material (apple-design §12): controls live in grouped
 * panels — an elevated card one step above the page, hairline-divided
 * rows, labels left, controls pinned right. Headers sit OUTSIDE the
 * panel. One shadow scale everywhere; depth is hierarchy, not decor.
 */
export function SettingsPanel({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card',
        'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.10)]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** One row: label + optional description on the left, control(s) right. */
export function SettingsRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-5">{label}</span>
        {description && (
          <span className="mt-px block text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  )
}

/** Group header above a panel: title + one quiet line of context. */
export function SettingsGroup({
  title,
  hint,
  children,
  action
}: {
  title: string
  hint?: string
  children: React.ReactNode
  /** quiet affordance aligned with the title (e.g. Reset) */
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-4 px-1">
        <div>
          <h3 className="text-[13px] font-medium">{title}</h3>
          {hint && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}
