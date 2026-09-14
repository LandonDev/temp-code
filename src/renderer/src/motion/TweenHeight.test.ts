import { describe, expect, it } from "vitest";
import { EASE_OUT_CSS } from "../lib/ease";
import { TWEEN_FALLBACK_MS, TWEEN_MS, tweenHeight, type TweenEndEvent, type TweenTarget } from "./TweenHeight";

/** A fake element plus fake timers, so the tween's timing is checkable. */
function rig(from: number, scroll: number) {
  const listeners = new Set<(event: TweenEndEvent) => void>();
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
  const fire = (event: TweenEndEvent = { target: el, propertyName: "height" }) => {
    for (const cb of [...listeners]) cb(event);
  };
  return { el, timers, pending, fire, listeners };
}

describe("tweenHeight", () => {
  it("tweens from the measured height to the scroll height, then hands back to auto", () => {
    const { el, timers, pending, fire, listeners } = rig(0, 120);
    tweenHeight(el, true, timers);
    expect(el.style.transition).toBe(`height ${TWEEN_MS}ms ${EASE_OUT_CSS}`);
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

describe("TweenHeight markup", () => {
  it("never passes height through the style prop (React would commit the target before the tween measures)", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { TweenHeight } = await import("./TweenHeight");
    for (const open of [true, false]) {
      const html = renderToStaticMarkup(createElement(TweenHeight, { open, animate: true }, "x"));
      expect(html).not.toContain("height");
      expect(html).toContain("overflow-hidden");
    }
  });
});

describe("tweenHeight transitionend filtering", () => {
  it("ignores a transitionend from a child or for another property", () => {
    const { el, timers, fire, listeners } = rig(0, 120);
    tweenHeight(el, true, timers);
    fire({ target: {}, propertyName: "height" });
    fire({ target: el, propertyName: "opacity" });
    expect(el.style.height).toBe("120px");
    expect(listeners.size).toBe(1);
    fire();
    expect(el.style.height).toBe("auto");
  });
});
