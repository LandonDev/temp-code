/** Proper product names for addon references — a connector mention reads
 *  as the product ("Linear", "GitHub"), never as a slash token. */
const PROPER: Record<string, string> = {
  github: 'GitHub',
  'google-drive': 'Google Drive',
  googledrive: 'Google Drive',
  heroui: 'HeroUI',
  reui: 'ReUI',
  node_repl: 'Node REPL',
  openaideveloperdocs: 'OpenAI Docs',
  pdf: 'PDF',
  'computer-use': 'Computer Use'
}

export function addonTitle(name: string): string {
  const known = PROPER[name.toLowerCase()]
  if (known) return known
  return name
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}
