/**
 * What a pasted text becomes. Short text goes into the box as typed
 * text; a long one (a log, a file) would make the contenteditable crawl
 * on every keystroke after it, so it rides as a text attachment instead,
 * the same chip a dropped file shows.
 */
export const PASTE_ATTACH_THRESHOLD = 10 * 1024

export type PastePlan = { inline: string } | { attach: File }

export function pastePlan(raw: string, threshold = PASTE_ATTACH_THRESHOLD): PastePlan {
  const text = raw.replace(/\r\n?/g, '\n')
  if (text.length <= threshold) return { inline: text }
  return { attach: new File([text], pastedFileName(text), { type: 'text/plain' }) }
}

function pastedFileName(text: string): string {
  const lines = text.split('\n').length
  return `pasted-${lines}-lines.txt`
}
