import { useSyncExternalStore } from "react";
import { sessionStore } from "./tcserver/store";

/**
 * `@thread:<id>` tokens: a thread mentioned from the composer rides to
 * the server as the token plus a thread attachment, and reads back in the
 * transcript as the thread's title. An id nobody knows stays as typed.
 * A thread on another host than the one the message runs on is
 * `@thread:<host>:<id>`, the host's own id (`env_…`): that host reads it
 * there (docs/box.md "One project across hosts: threads see each other").
 * The store is keyed by bare session id, so titles and chips use that.
 */

const THREAD_TOKEN = /@thread:((?:env_[A-Za-z0-9_-]{22}:)?[\w-]{6,})/g;
const THREAD_HREF = "#thread:";

export type TitleOf = (id: string) => string | undefined;

export type ThreadMentionPart = { text: string } | { id: string; title: string };

/** What a token names: the session, and its host when the token carries one. */
export type ThreadRef = { sessionId: string; hostId?: string };

function parseRef(ref: string): ThreadRef {
  const at = ref.indexOf(":");
  return at < 0 ? { sessionId: ref } : { sessionId: ref.slice(at + 1), hostId: ref.slice(0, at) };
}

/** The token the composer inserts: the host rides only when the thread lives on another host than the draft's. */
export function threadToken(sessionId: string, threadHostId: string | undefined, draftHostId: string | undefined): string {
  const foreign = threadHostId?.startsWith("env_") && threadHostId !== draftHostId;
  return foreign ? `@thread:${threadHostId}:${sessionId}` : `@thread:${sessionId}`;
}

/** Unique references in the text, in order, each with the host its token names. */
export function threadRefsInText(text: string): ThreadRef[] {
  const refs: ThreadRef[] = [];
  for (const m of text.matchAll(THREAD_TOKEN)) {
    const ref = parseRef(m[1]!);
    if (!refs.some((r) => r.sessionId === ref.sessionId && r.hostId === ref.hostId)) refs.push(ref);
  }
  return refs;
}

/** Unique thread ids mentioned in the text, in order. */
export function threadMentionsInText(text: string): string[] {
  const ids: string[] = [];
  for (const { sessionId } of threadRefsInText(text)) {
    if (!ids.includes(sessionId)) ids.push(sessionId);
  }
  return ids;
}

/** Split text so known thread tokens can render as chips. */
export function threadMentionParts(text: string, titleOf: TitleOf): ThreadMentionPart[] {
  const parts: ThreadMentionPart[] = [];
  let cursor = 0;
  for (const m of text.matchAll(THREAD_TOKEN)) {
    const id = parseRef(m[1]!).sessionId;
    const title = titleOf(id);
    if (!title) continue;
    if (m.index > cursor) parts.push({ text: text.slice(cursor, m.index) });
    parts.push({ id, title });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** Known tokens become `[@title](#thread:id)` links for the markdown renderer. */
export function threadMentionsToLinks(text: string, titleOf: TitleOf): string {
  return text.replace(THREAD_TOKEN, (token, ref: string) => {
    const id = parseRef(ref).sessionId;
    const title = titleOf(id);
    return title ? `[@${title}](${THREAD_HREF}${id})` : token;
  });
}

/** Known tokens become `@title`, for copies and plain text. */
export function threadMentionsToTitles(text: string, titleOf: TitleOf): string {
  return text.replace(THREAD_TOKEN, (token, ref: string) => {
    const title = titleOf(parseRef(ref).sessionId);
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

/** Titles for a known set of thread ids, re-rendering only when one changes. */
export function useTitlesOf(ids: string[]): TitleOf {
  const snapshot = () => ids.map((id) => `${id}=${storeTitleOf(id) ?? ""}`).join("|");
  useSyncExternalStore(subscribeMetas, snapshot, snapshot);
  return storeTitleOf;
}
