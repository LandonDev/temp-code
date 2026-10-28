import type { Link } from "./link";

/**
 * A settings load made before the window's socket is open (a reload, a
 * page opened at boot): it waits for the open instead of spending the
 * link's retries against a socket that is not there, and past a deadline
 * it says so, so the page can show its error and Retry. The read itself
 * keeps going: a late answer still lands.
 */

/** How long a load may take, the socket's opening included, before its page says so. */
export const LOAD_DEADLINE_MS = 10_000;
export const NO_ANSWER = "The host did not answer";

/** Resolves when the link's socket is open: at once, or at its next open. */
export function whenOpen(link: Link): Promise<void> {
  if (link.connected) return Promise.resolve();
  return new Promise((resolve) => {
    const off = link.onOpen(() => {
      off();
      resolve();
    });
  });
}

/** A read asked once the socket is open, with the link's retry for a socket that drops under it. */
export function readWhenOpen<T>(link: Link, method: string, params: unknown): Promise<T> {
  return whenOpen(link).then(() => link.request<T>(method, params, { retry: true }));
}

/** `p`, or a rejection with NO_ANSWER past `ms`; `p` itself keeps running. */
export function withDeadline<T>(p: Promise<T>, ms = LOAD_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NO_ANSWER)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
