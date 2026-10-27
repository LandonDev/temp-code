import { useEffect, useRef } from "react";
import type { toast as Toast } from "sonner";

export type ToastApi = typeof Toast;

/** sonner rides its own chunk (the Toaster is lazy in main.tsx); the first
 *  toast loads it, so `toast()` never sits in the first paint. */
export function loadToast(): Promise<ToastApi> {
  return import("sonner").then((m) => m.toast);
}

/** Mirrors a list into sonner: each item shows, or updates in place, under
 *  its id; an id that leaves the list is dismissed. */
export function useToastSync<T>(items: readonly T[], idOf: (item: T) => string, show: (toast: ToastApi, item: T, id: string) => void): void {
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(items.map(idOf));
    const gone = [...shown.current].filter((id) => !next.has(id));
    shown.current = next;
    if (items.length === 0 && gone.length === 0) return;
    void loadToast().then((toast) => {
      for (const item of items) show(toast, item, idOf(item));
      for (const id of gone) toast.dismiss(id);
    });
    // The list is the input; the callbacks are read fresh on each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}
