import { loadProjectFiles } from "./fileIndex";
import { buildMentionIndex, fileMentionsInText } from "./fileMentions";
import type { ProjectFile } from "./fs";
import { looksLikeProject } from "./recents";
import type { ServerAttachment } from "./tcserver/types";
import { storeTitleOf, threadMentionsInText, type TitleOf } from "./threadMentions";

/**
 * What a turn's `@` tokens mean to the server: every `@path` that names a
 * project file rides as a file attachment, every `@thread:<id>` as a
 * thread attachment. The text itself stays as typed, and the visible turn
 * shows only what the user attached by hand — these are implied by the
 * tokens.
 */
export function mentionAttachments(
  text: string,
  files: readonly ProjectFile[],
  titleOf: TitleOf,
): ServerAttachment[] {
  const out: ServerAttachment[] = [];
  if (files.length > 0) {
    const index = buildMentionIndex([...files]);
    for (const hit of fileMentionsInText(text, index.labels)) {
      if (hit.file.isDir) continue;
      out.push({ kind: "file", path: hit.file.path, name: hit.file.name });
    }
  }
  for (const id of threadMentionsInText(text)) {
    out.push({ kind: "thread", path: `thread:${id}`, name: titleOf(id) ?? id, sessionId: id });
  }
  return out;
}

export async function deriveMentionAttachments(
  text: string,
  cwd: string,
): Promise<ServerAttachment[]> {
  if (!/(^|\s)@\S/.test(text)) return [];
  const files = looksLikeProject(cwd) ? await loadProjectFiles(cwd).catch(() => []) : [];
  return mentionAttachments(text, files, storeTitleOf);
}
