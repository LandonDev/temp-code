import { z } from 'zod'

/**
 * The workspace "completed turn" setting: what a thread's model does on
 * its own after every settled turn. Actions mix and match — verify and
 * build are independent toggles, commit escalates to push. Stored per
 * workspace in the settings table (`turn-pass:<workspaceId>`); the
 * registry injects the pass as its own turn after the real one settles,
 * marked by a `turn-pass` event so the transcript can highlight it.
 */
export const TurnPassSchema = z.object({
  /** verify the turn's work (typecheck / tests / whatever the project defines) */
  verify: z.boolean().default(false),
  /** produce a build */
  build: z.boolean().default(false),
  /** commit the turn's changes to the project branch, optionally pushing */
  commit: z.enum(['off', 'commit', 'push']).default('off')
})
export type TurnPass = z.infer<typeof TurnPassSchema>

export const TURN_PASS_OFF: TurnPass = { verify: false, build: false, commit: 'off' }

export const passEnabled = (p: TurnPass | null): p is TurnPass =>
  p !== null && (p.verify || p.build || p.commit !== 'off')

/** Short labels for the configured actions (marker row, settings hint). */
export function passActions(p: TurnPass): string[] {
  const out: string[] = []
  if (p.verify) out.push('Verify')
  if (p.build) out.push('Build')
  if (p.commit === 'commit') out.push('Commit')
  if (p.commit === 'push') out.push('Commit & push')
  return out
}

/** Parse stored JSON; anything invalid reads as unset. */
export function parseTurnPass(raw: string | null): TurnPass | null {
  if (!raw) return null
  try {
    return TurnPassSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}
