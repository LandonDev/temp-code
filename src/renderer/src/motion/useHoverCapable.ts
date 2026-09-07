import { useEffect, useState } from "react";

/**
 * True only on devices with a real hover (mouse / trackpad). Touch devices
 * fire a phantom `:hover` on tap that sticks until the next tap — gate
 * hover-only effects (scale lifts, magnetic pulls) behind this.
 */
export function useHoverCapable(): boolean {
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setCanHover(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  return canHover;
}
