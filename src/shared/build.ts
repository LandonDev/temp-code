import { z } from 'zod'

/**
 * The Build tab's command (docs: right rail → Build). A workspace holds
 * the default (`build:<workspaceId>`), a project may override it
 * (`build:project:<projectId>`); with neither set the server detects one
 * from the checkout (pom.xml → mvn, gradlew → gradle, package.json build
 * script → bun run build). `outputs` is a comma-separated glob list
 * relative to the checkout, `!` negates; empty = scan the log for
 * artifact paths instead.
 */
export const BuildConfigSchema = z.object({
  command: z.string(),
  outputs: z.string().default('')
})
export type BuildConfig = z.infer<typeof BuildConfigSchema>

/** Parse stored JSON; anything invalid (or an empty command) reads as unset. */
export function parseBuildConfig(raw: string | null): BuildConfig | null {
  if (!raw) return null
  try {
    const cfg = BuildConfigSchema.parse(JSON.parse(raw))
    return cfg.command.trim() ? cfg : null
  } catch {
    return null
  }
}

/** What a project actually runs, and where the command came from. */
export interface EffectiveBuild extends BuildConfig {
  source: 'project' | 'workspace' | 'detected'
}

/** One file a build produced (or matched but did not touch: fresh=false). */
export interface BuildOutput {
  /** relative to the checkout */
  path: string
  abs: string
  size: number
  mtimeMs: number
  /** written during this run */
  fresh: boolean
}

export type BuildStatus = 'running' | 'ok' | 'failed' | 'cancelled'

export interface BuildRun {
  id: string
  status: BuildStatus
  command: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  outputs: BuildOutput[]
}

/** Split the outputs field into positive and negated globs. */
export function splitGlobs(outputs: string): { include: string[]; exclude: string[] } {
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of outputs.split(',')) {
    const g = raw.trim()
    if (!g) continue
    if (g.startsWith('!')) exclude.push(g.slice(1))
    else include.push(g)
  }
  return { include, exclude }
}
