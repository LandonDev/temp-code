import * as si from 'simple-icons'

/** Brand marks for addon names (simple-icons: one path per brand). */
type SimpleIcon = { path: string; hex: string }

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

export function brandOf(name: string): SimpleIcon | undefined {
  return BRANDS[name.toLowerCase()]
}
