import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** Mirrors a list into sonner: each item shows, or updates in place, under
 *  its id; an id that leaves the list is dismissed. */
export function useToastSync<T>(items: readonly T[], idOf: (item: T) => string, show: (item: T, id: string) => void): void {
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(items.map(idOf));
    for (const item of items) show(item, idOf(item));
    for (const id of shown.current) if (!next.has(id)) toast.dismiss(id);
    shown.current = next;
    // The list is the input; the callbacks are read fresh on each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}
