import { cn } from '../../lib/utils'

/** Small on/off switch — settings rows, rule toggles. */
export function Switch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-150',
        checked ? 'bg-primary' : 'bg-border-strong',
        disabled && 'opacity-40'
      )}
    >
      <span
        className={cn(
          // bg-background keeps the knob readable on both track states in
          // both themes (dark knob on the light dark-mode primary track).
          'absolute top-[2px] left-[2px] size-[14px] rounded-full bg-background shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-150 ease-out',
          checked && 'translate-x-3'
        )}
      />
    </button>
  )
}
