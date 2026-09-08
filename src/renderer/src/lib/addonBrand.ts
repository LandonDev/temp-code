// Named imports only: a wildcard would pull every brand into the bundle.
import {
  siClerk,
  siCloudflare,
  siConvex,
  siFigma,
  siGithub,
  siGoogledrive,
  siLinear,
  siNotion,
  siPostgresql,
  siSentry,
  siStripe,
  siSupabase,
  siTrello,
  siVercel,
  siWebflow,
} from "simple-icons";

/** Brand marks for addon names (simple-icons: one path per brand). */
export type BrandIcon = { path: string; hex: string };

const BRANDS: Record<string, BrandIcon | undefined> = {
  linear: siLinear,
  github: siGithub,
  vercel: siVercel,
  stripe: siStripe,
  sentry: siSentry,
  trello: siTrello,
  clerk: siClerk,
  convex: siConvex,
  notion: siNotion,
  figma: siFigma,
  "google-drive": siGoogledrive,
  googledrive: siGoogledrive,
  webflow: siWebflow,
  cloudflare: siCloudflare,
  supabase: siSupabase,
  postgres: siPostgresql,
};

export function brandOf(name: string): BrandIcon | undefined {
  return BRANDS[name.toLowerCase()];
}
