import type { Attachment } from "./session";

/** A copied prompt: the token text plus its attachments, verbatim. */
export type CopiedMessage = { text: string; attachments: Attachment[] };

const ATTR = "data-temp-code-message";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The clipboard flavours of a copied prompt: text/plain pastes anywhere;
 *  the HTML flavour carries the full payload so a paste back into the
 *  composer restores images, files and thread references. */
export function messageClipboardHtml(msg: CopiedMessage): string {
  const payload = encodeURIComponent(JSON.stringify(msg));
  return `<div ${ATTR}="${payload}">${escapeHtml(msg.text)}</div>`;
}

export function copyUserMessage(msg: CopiedMessage): Promise<void> {
  if (typeof ClipboardItem === "undefined") return navigator.clipboard.writeText(msg.text);
  return navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([msg.text], { type: "text/plain" }),
      "text/html": new Blob([messageClipboardHtml(msg)], { type: "text/html" }),
    }),
  ]);
}

/** The copied-prompt payload in pasted HTML, if it carries one. */
export function parseCopiedMessage(html: string): CopiedMessage | null {
  const m = new RegExp(`${ATTR}="([^"]*)"`).exec(html);
  if (!m) return null;
  try {
    const msg = JSON.parse(decodeURIComponent(m[1])) as CopiedMessage;
    if (typeof msg.text !== "string" || !Array.isArray(msg.attachments)) return null;
    return msg;
  } catch {
    return null;
  }
}

export function readCopiedMessage(dt: DataTransfer): CopiedMessage | null {
  const html = dt.getData("text/html");
  return html ? parseCopiedMessage(html) : null;
}
