import { useSyncExternalStore } from "react";
import { sessionStore } from "./tcserver/store";

/**
 * `@thread:<id>` tokens: a thread mentioned from the composer rides to
 * the server as the token plus a thread attachment, and reads back in the
 * transcript as the thread's title. An id nobody knows stays as typed.
 */

const THREAD_TOKEN = /@thread:([\w-]{6,})/g;
const THREAD_HREF = "#thread:";

export type TitleOf = (id: string) => string | undefined;

export type ThreadMentionPart = { text: string } | { id: string; title: string };

/** Unique thread ids mentioned in the text, in order. */
export function threadMentionsInText(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(THREAD_TOKEN)) {
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

/** Split text so known thread tokens can render as chips. */
export function threadMentionParts(text: string, titleOf: TitleOf): ThreadMentionPart[] {
  const parts: ThreadMentionPart[] = [];
  let cursor = 0;
  for (const m of text.matchAll(THREAD_TOKEN)) {
    const title = titleOf(m[1]!);
    if (!title) continue;
    if (m.index > cursor) parts.push({ text: text.slice(cursor, m.index) });
    parts.push({ id: m[1]!, title });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Known tokens become `[@title](#thread:id)` links for the markdown renderer. */
export function threadMentionsToLinks(text: string, titleOf: TitleOf): string {
  return text.replace(THREAD_TOKEN, (token, id: string) => {
    const title = titleOf(id);
    return title ? `[@${title}](${THREAD_HREF}${id})` : token;
  });
}

/** Known tokens become `@title`, for copies and plain text. */
export function threadMentionsToTitles(text: string, titleOf: TitleOf): string {
  return text.replace(THREAD_TOKEN, (token, id: string) => {
    const title = titleOf(id);
    return title ? `@${title}` : token;
  });
}

/** The thread id an href points at, when it is one of ours. */
export function threadIdFromHref(href: string | undefined): string | undefined {
  return href?.startsWith(THREAD_HREF) ? href.slice(THREAD_HREF.length) : undefined;
}

export function hasThreadMention(text: string): boolean {
  return text.includes("@thread:");
}

export const storeTitleOf: TitleOf = (id) => sessionStore.metaOf(id)?.title;

const subscribeMetas = (l: () => void): (() => void) => sessionStore.onMetaChange(l);

/** Titles for the threads a text mentions, re-rendering only when one of them changes. */
export function useThreadTitles(text: string): TitleOf {
  const ids = hasThreadMention(text) ? threadMentionsInText(text) : [];
  const snapshot = () => ids.map((id) => `${id}=${storeTitleOf(id) ?? ""}`).join("|");
  useSyncExternalStore(subscribeMetas, snapshot, snapshot);
  return storeTitleOf;
}
