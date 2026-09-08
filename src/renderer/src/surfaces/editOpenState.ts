import { useState } from "react";
import type { Block } from "../lib/session";

/**
 * Whether the user opened or closed an edit row's diff, kept per session
 * and call across virtualization, pane swaps and restarts. Unset means the
 * row follows its automatic open/hold/fold.
 */

const STORAGE_KEY = "temp-code.editOpen";
const CAP = 400;

let cache: Map<string, boolean> | null = null;

function store(): Map<string, boolean> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "boolean") cache.set(k, v);
      }
    }
  } catch {
    /* a bad entry just means no memory */
  }
  return cache;
}

function persist(map: Map<string, boolean>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* quota or private mode: state lives for the session */
  }
}

export function editOpenKey(sessionId: string | undefined, block: Block): string {
  return `${sessionId ?? "-"}:${block.tool?.callId ?? block.id}`;
}

export function getEditOpen(key: string): boolean | undefined {
  return store().get(key);
}

export function setEditOpen(key: string, open: boolean): void {
  const map = store();
  map.delete(key);
  map.set(key, open);
  while (map.size > CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  persist(map);
}

/** `null` until the user toggles; the setter remembers across mounts. */
export function usePersistedOpen(key: string): [boolean | null, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean | null>(() => getEditOpen(key) ?? null);
  return [
    open,
    (next: boolean) => {
      setEditOpen(key, next);
      setOpen(next);
    },
  ];
}
