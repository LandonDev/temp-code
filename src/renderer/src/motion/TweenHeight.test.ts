import { describe, expect, it } from "vitest";
import { TWEEN_FALLBACK_MS, TWEEN_MS, tweenHeight, type TweenTarget } from "./TweenHeight";

/** A fake element plus fake timers, so the tween's timing is checkable. */
function rig(from: number, scroll: number) {
  const listeners = new Set<() => void>();
  const el: TweenTarget = {
    scrollHeight: scroll,
    offsetHeight: from,
    style: { transition: "", height: "" },
    addEventListener: (_t, cb) => void listeners.add(cb),
    removeEventListener: (_t, cb) => void listeners.delete(cb),
  };
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  const timers = {
    setTimeout: (cb: () => void, ms: number) => {
      pending.set(next, { cb, ms });
      return next++;
    },
    clearTimeout: (id: number) => void pending.delete(id),
  };
  const fire = () => {
    for (const cb of [...listeners]) cb();
  };
  return { el, timers, pending, fire, listeners };
}

describe("tweenHeight", () => {
  it("tweens from the measured height to the scroll height, then hands back to auto", () => {
    const { el, timers, pending, fire, listeners } = rig(0, 120);
    tweenHeight(el, true, timers);
    expect(el.style.transition).toBe(`height ${TWEEN_MS}ms ease-out`);
    expect(el.style.height).toBe("120px");
    expect(listeners.size).toBe(1);
    expect([...pending.values()][0]?.ms).toBe(TWEEN_FALLBACK_MS);
    fire();
    expect(el.style.height).toBe("auto");
    expect(el.style.transition).toBe("none");
    expect(listeners.size).toBe(0);
    expect(pending.size).toBe(0);
  });

  it("closes to 0px and the fallback timer finishes when transitionend never fires", () => {
    const { el, timers, pending, listeners } = rig(120, 120);
    tweenHeight(el, false, timers);
    expect(el.style.height).toBe("0px");
    const [fallback] = [...pending.values()];
    fallback?.cb();
    expect(el.style.height).toBe("0px");
    expect(el.style.transition).toBe("none");
    expect(listeners.size).toBe(0);
  });

  it("cancel detaches the listener and the timer", () => {
    const { el, timers, pending, listeners } = rig(0, 80);
    const cancel = tweenHeight(el, true, timers);
    cancel();
    expect(listeners.size).toBe(0);
    expect(pending.size).toBe(0);
  });

  it("snaps when there is nothing to tween", () => {
    const { el, timers, pending, listeners } = rig(0, 0);
    tweenHeight(el, false, timers);
    expect(el.style.height).toBe("0px");
    expect(listeners.size).toBe(0);
    expect(pending.size).toBe(0);
  });
});
