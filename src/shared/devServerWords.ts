// What a dev server is, in plain words (docs/box.md "Dev servers on the box"):
// the host names a target by it in the starter, and the Dev servers pane
// titles a running server by it, whether the Run button or a thread's own
// shell started it. Read from the command, never from a guess about the app.

const FRAMEWORKS: [RegExp, string][] = [
  [/\bexpo\b/, 'expo'],
  [/\bnext\b/, 'next'],
  [/\bnuxt\b/, 'nuxt'],
  [/\bastro\b/, 'astro'],
  [/\bremix\b/, 'remix'],
  [/\bsvelte-kit\b|\bsveltekit\b/, 'sveltekit'],
  [/\bstorybook\b/, 'storybook'],
  [/\bvite\b/, 'vite'],
  [/\bwebpack(?:-dev-server)?\b/, 'webpack'],
  [/\breact-scripts\b/, 'react-scripts'],
  [/\bwrangler\b/, 'wrangler'],
  [/\bconvex\b/, 'convex'],
  [/\bbun\b/, 'bun'],
  [/\bnodemon\b|\bnode\b|\btsx\b/, 'node']
]

/** The framework a command runs: vite, next, expo, …; null when it names none. */
export function frameworkOf(command: string): string | null {
  for (const [re, name] of FRAMEWORKS) if (re.test(command)) return name
  return null
}

const WORDS: Record<string, string> = {
  expo: 'Expo app',
  next: 'Next.js dev server',
  nuxt: 'Nuxt dev server',
  astro: 'Astro dev server',
  remix: 'Remix dev server',
  sveltekit: 'SvelteKit dev server',
  storybook: 'Storybook',
  vite: 'Vite dev server',
  webpack: 'Webpack dev server',
  'react-scripts': 'React dev server',
  wrangler: 'Wrangler dev server',
  convex: 'Convex dev server',
  bun: 'Bun server',
  node: 'Node server',
  xcode: 'iOS app in the Simulator'
}

/** "Vite dev server", "Expo app", "iOS app in the Simulator"; "Dev server" when the framework is unknown. */
export function serverWords(framework: string | null): string {
  return (framework && WORDS[framework]) || 'Dev server'
}

/** A command line with its package runner read past: "bun run dev" runs a script, not Bun. */
const bareOf = (command: string): string =>
  command.replace(/\b(?:bun|npm|pnpm|yarn)\s+run\b|\b(?:npx|bunx|pnpx)\b|\b(?:pnpm|yarn)\s+(?=[a-z])/g, ' ')

/** A command line in plain words, its package runner ("bun run dev", "npx vite") read past: "bun run dev" is a Dev server, not a Bun server. */
export function commandWords(command: string): string {
  return serverWords(frameworkOf(bareOf(command)))
}

/** A listening port in plain words: the framework of the process that listens ("node …/vite" is a Vite dev server), else of the command that opened it. */
export function listenerWords(process: string | null | undefined, label: string): string {
  return serverWords((process ? frameworkOf(bareOf(process)) : null) ?? frameworkOf(bareOf(label)))
}
