import type { Attachment } from '@shared/events'

/** A copied prompt: the token text plus its attachments, verbatim. */
export interface CopiedMessage {
  text: string
  attachments: Attachment[]
}

const ATTR = 'data-temp-code-message'

/** Copy a user prompt. text/plain carries the token text (pastes anywhere);
 *  an HTML flavor smuggles the full payload so pasting back into the
 *  composer restores appshots, images, files and thread references. */
export function copyUserMessage(msg: CopiedMessage): void {
  const payload = encodeURIComponent(JSON.stringify(msg))
  const html = `<div ${ATTR}="${payload}">${escapeHtml(msg.text)}</div>`
  void navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([msg.text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' })
    })
  ])
}

/** Copy an assistant response as markdown. */
export function copyMarkdown(text: string): void {
  void navigator.clipboard.writeText(text)
}

/** The copied-prompt payload in a paste, if the clipboard carries one. */
export function readCopiedMessage(dt: DataTransfer): CopiedMessage | null {
  const html = dt.getData('text/html')
  if (!html || !html.includes(ATTR)) return null
  const el = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${ATTR}]`)
  const raw = el?.getAttribute(ATTR)
  if (!raw) return null
  try {
    const msg = JSON.parse(decodeURIComponent(raw)) as CopiedMessage
    if (typeof msg.text !== 'string' || !Array.isArray(msg.attachments)) return null
    return msg
  } catch {
    return null
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
