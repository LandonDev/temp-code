/**
 * Titles a thread carries until its first message: the host's per-type
 * placeholders (`THREAD_TITLES`, what `session.create` names an untitled
 * thread), the `provider · agentType` fallback, and the desktop's draft
 * label (the harness id). The first send replaces the title with a slice of
 * the message, so a placeholder title on a thread with no rows means no
 * message ever went in. The host's empty-thread sweep and the desktop's
 * restore both read it.
 */
export const THREAD_TITLES = {
  chat: 'New chat',
  planning: 'New plan',
  'project-plan': 'Project plan',
  implementation: 'New task',
  orchestration: 'New orchestration',
  research: 'New research'
} as const

const HARNESS_LABELS = ['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx', 'muse']

const PLACEHOLDERS = new Set<string>([...Object.values(THREAD_TITLES), ...HARNESS_LABELS])

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDERS.has(title) || /^[a-z]+ · [a-z_-]+$/i.test(title)
}
