import { applyNotesToTurn } from "./notes";

/** What the client still adds to a turn before the server sees it: note
 *  bodies. Slash commands expand on the server; `@` mentions ride as
 *  attachments. */
export function preparePrompt(text: string): Promise<string> {
  return applyNotesToTurn(text);
}
