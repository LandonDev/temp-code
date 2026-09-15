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
import cosmicAdminMark from "../assets/mcp/cosmic-admin.png";

/** Brand marks for addon names: a simple-icons vector, or a raster mark for
 *  a brand simple-icons doesn't carry. */
export type BrandIcon = { path: string; hex: string } | { img: string };

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
  "cosmic-admin": { img: cosmicAdminMark },
};

export function brandOf(name: string): BrandIcon | undefined {
  return BRANDS[name.toLowerCase()];
}
