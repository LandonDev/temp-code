import { useEffect, useState, type RefObject } from "react";

/** How far outside the viewport still counts as near: about a screen. */
const MARGIN = "400px";

/**
 * True once the element is within a screen of the viewport, and true from
 * then on. A row parked out of sight (an older turn, a hidden tab) can
 * hold its fetches until the user is about to see it. Where there is no
 * IntersectionObserver (tests), true at once.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}
