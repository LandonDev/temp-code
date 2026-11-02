import { useEffect, useRef } from "react";
import { loadToast, type ToastApi } from "../components/ui/toaster";

export { loadToast, type ToastApi };

type Shown = { signature: string; cleanup: void | (() => void) };

/** Mirrors changed items into sonner; each owner dismisses its toasts on exit.
 *  A show callback may return cleanup for any secondary toasts it creates. */
export function useToastSync<T>(items: readonly T[], idOf: (item: T) => string, show: (toast: ToastApi, item: T, id: string) => void | (() => void), signatureOf: (item: T) => string): void {
  const shown = useRef(new Map<string, Shown>());
  const api = useRef<ToastApi | null>(null);
  useEffect(() => () => {
    for (const [id, entry] of shown.current) {
      entry.cleanup?.();
      api.current?.dismiss(id);
    }
    shown.current.clear();
  }, []);
  useEffect(() => {
    let live = true;
    const next = new Map(items.map((item) => [idOf(item), { item, signature: signatureOf(item) }]));
    const gone = [...shown.current.keys()].filter((id) => !next.has(id));
    const changed = [...next].filter(([id, entry]) => shown.current.get(id)?.signature !== entry.signature);
    if (changed.length === 0 && gone.length === 0) return;
    void loadToast().then((toast) => {
      if (!live) return;
      api.current = toast;
      for (const id of gone) {
        shown.current.get(id)?.cleanup?.();
        toast.dismiss(id);
        shown.current.delete(id);
      }
      for (const [id, { item, signature }] of changed) {
        shown.current.get(id)?.cleanup?.();
        const cleanup = show(toast, item, id);
        shown.current.set(id, { signature, cleanup });
      }
    });
    return () => { live = false; };
    // The list is the input; the callbacks are read fresh on each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}
