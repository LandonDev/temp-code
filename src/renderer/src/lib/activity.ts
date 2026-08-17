import type { Block } from '../state/blocks'

/** One line about what a session is doing right now: the latest tool call
 *  (verb · target), assistant sentence, or error — scanning backwards. */
export function activityLine(blocks: Block[] | undefined): string | null {
  if (!blocks?.length) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'tool') {
      const input = (b.input ?? {}) as Record<string, unknown>
      const detail = [
        input.command,
        input.file_path,
        input.pattern,
        input.description,
        input.query
      ].find((v) => typeof v === 'string') as string | undefined
      return detail ? `${b.name} · ${detail}` : b.name
    }
    if (b.kind === 'assistant' && b.text.trim()) return b.text.trim().split('\n')[0]
    if (b.kind === 'error' && !b.cleared) return b.text
  }
  return null
}

/** Last settled assistant sentence — a finished agent's own summary. */
export function lastAssistantLine(blocks: Block[] | undefined): string | null {
  if (!blocks?.length) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'assistant' && b.text.trim()) return b.text.trim().split('\n')[0]
  }
  return null
}

/** The task a subagent was given: its first user message's first line. */
export function taskTitle(blocks: Block[] | undefined): string | null {
  const user = blocks?.find((b) => b.kind === 'user')
  if (user?.kind !== 'user') return null
  return user.text.trim().split('\n')[0] || null
}
