import { Blocks, Plug, SlashSquare, SquareTerminal } from 'lucide-react'
import type { SlashCommand } from '@shared/domain'
import * as si from 'simple-icons'
import { cn } from '../../lib/utils'

/**
 * The face of a slash reference: real brand marks for the addons that
 * have one (Linear looks like Linear), quiet category glyphs for the
 * rest. simple-icons is data-only — one path per brand.
 */

type SimpleIcon = { path: string; hex: string }

/** addon name (as configured) → simple-icons export */
const BRANDS: Record<string, SimpleIcon | undefined> = {
  linear: si.siLinear,
  github: si.siGithub,
  vercel: si.siVercel,
  stripe: si.siStripe,
  sentry: si.siSentry,
  trello: si.siTrello,
  clerk: si.siClerk,
  convex: si.siConvex,
  notion: si.siNotion,
  figma: si.siFigma,
  'google-drive': si.siGoogledrive,
  googledrive: si.siGoogledrive,
  webflow: si.siWebflow,
  cloudflare: si.siCloudflare,
  supabase: si.siSupabase,
  postgres: si.siPostgresql
}

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
  const brand = BRANDS[command.name.toLowerCase()]
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
