import { Blocks, Plug, SlashSquare, SquareTerminal } from 'lucide-react'
import type { SlashCommand } from '@shared/domain'
import { cn } from '../../lib/utils'
import { brandOf } from '../../lib/addon-brand'

/**
 * The face of a slash reference: real brand marks for the addons that
 * have one (Linear looks like Linear), quiet category glyphs for the
 * rest. simple-icons is data-only — one path per brand.
 */

export function AddonMark({
  command,
  size = 14,
  colored = true,
  className
}: {
  command: Pick<SlashCommand, 'name' | 'source'>
  size?: number
  /** brand color for menus; monochrome (currentColor) inside chips */
  colored?: boolean
  className?: string
}): React.JSX.Element {
  const brand = brandOf(command.name)
  if (brand) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={cn('shrink-0', className)}
        aria-hidden
      >
        <path d={brand.path} fill={colored ? `#${brand.hex}` : 'currentColor'} />
      </svg>
    )
  }
  const cls = cn('shrink-0 text-muted-foreground', className)
  const px = { width: size, height: size }
  switch (command.source) {
    case 'plugin':
      return <Blocks style={px} className={cls} />
    case 'mcp':
      return <Plug style={px} className={cls} />
    case 'prompt':
      return <SquareTerminal style={px} className={cls} />
    default:
      return <SlashSquare style={px} className={cls} />
  }
}

/** Menu trailing label — what kind of thing this reference is. */
export function SourceLabel({ source }: { source: SlashCommand['source'] }): React.JSX.Element {
  return <>{source === 'mcp' ? 'MCP' : source}</>
}
