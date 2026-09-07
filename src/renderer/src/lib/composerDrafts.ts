import type { ComposerSegment } from '../chrome/ComposerInput'
import type { Attachment } from './session'

/** What a thread's composer held when its pane went away; the next mount
 *  of that thread's composer takes it back, chips and attachments intact. */
export type ComposerDraft = { segments: ComposerSegment[]; attachments: Attachment[] }

const drafts = new Map<string, ComposerDraft>()

export function saveComposerDraft(sessionId: string, draft: ComposerDraft): void {
  const empty =
    draft.attachments.length === 0 &&
    draft.segments.every((s) => 'text' in s && s.text.trim().length === 0)
  if (empty) drafts.delete(sessionId)
  else drafts.set(sessionId, draft)
}

export function takeComposerDraft(sessionId: string): ComposerDraft | undefined {
  const draft = drafts.get(sessionId)
  drafts.delete(sessionId)
  return draft
}
