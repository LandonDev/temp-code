import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Link } from "./link";
import { withDeadline } from "./openRead";

export type HostRead<T> = {
  /** The host's answer; undefined until it has given one for this key. */
  value: T | undefined;
  /** Why the newest read failed (NO_ANSWER past the deadline); null while it runs or once it answered. */
  error: string | null;
  /** Asks again, keeping the value shown meanwhile. */
  retry: () => void;
  /** Puts a value in place: a change this page made and the host took. */
  set: (value: T) => void;
};

type State<T> = { key: string; value: T | undefined; error: string | null };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A page's read from a host, the way docs/DESIGN.md "Panels…" says a page
 * reads (lib/connection/openRead.ts): it waits for the socket to open, is
 * asked again on every new socket until it has answered, and past
 * LOAD_DEADLINE_MS reports NO_ANSWER for the page to show with Retry; a late
 * answer still lands. Never a value made up from a failure: until the host
 * answers, `value` is undefined. A new `key` (the read's parameters) starts
 * over from nothing; `retry` and a socket opening keep what is shown.
 */
export function useHostRead<T>(link: Link | null | undefined, read: () => Promise<T>, key = ""): HostRead<T> {
  const [state, setState] = useState<State<T>>({ key, value: undefined, error: null });
  // Bumped by Retry and by a socket opening while the value is missing.
  const [attempt, setAttempt] = useState(0);
  // A read in flight waits for the open itself; only a settled miss asks again.
  const pending = useRef(false);
  const latest = useRef(read);
  useLayoutEffect(() => {
    latest.current = read;
  });
  const current: State<T> = state.key === key ? state : { key, value: undefined, error: null };
  const loaded = current.value !== undefined;

  useEffect(() => {
    if (!link || loaded) return;
    return link.onOpen(() => {
      if (!pending.current) setAttempt((n) => n + 1);
    });
  }, [link, loaded]);

  useEffect(() => {
    if (!link) return;
    let live = true;
    pending.current = true;
    setState((s) => (s.key === key ? (s.error === null ? s : { ...s, error: null }) : { key, value: undefined, error: null }));
    // Asked at once on an open socket, so the request leaves with this render's effects;
    // otherwise at the next open, a waiter the cleanup drops so a superseded
    // read never sends on reconnect.
    let off: (() => void) | undefined;
    const answer = link.connected
      ? latest.current()
      : new Promise<void>((resolve) => {
          off = link.onOpen(() => {
            off?.();
            off = undefined;
            resolve();
          });
        }).then(() => latest.current());
    answer
      .then(
        (value) => live && setState({ key, value, error: null }),
        () => {},
      )
      .finally(() => {
        if (live) pending.current = false;
      });
    withDeadline(answer).catch((err: unknown) => {
      if (live) setState((s) => ({ key, value: s.key === key ? s.value : undefined, error: message(err) }));
    });
    return () => {
      live = false;
      off?.();
    };
  }, [link, key, attempt]);

  // Stable across renders, so an effect that polls with `retry` keeps its timer.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const set = useCallback((value: T) => setState({ key, value, error: null }), [key]);
  return { value: current.value, error: current.error, retry, set };
}
