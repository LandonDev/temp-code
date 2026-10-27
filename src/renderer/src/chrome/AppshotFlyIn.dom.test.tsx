// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUR, EASE_DRAWER } from "../lib/ease";

vi.mock("../lib/tcserver/store", () => ({ sessionStore: { environmentOf: () => "env_local" } }));
vi.mock("../lib/tcserver/commands", () => ({ readAttachment: () => new Promise(() => {}) }));
vi.mock("../lib/appshots", () => ({
  useAppshotFlash: () => ({ key: "k1", attachment: { path: "/tmp/shot.png" } }),
  clearAppshotFlash: () => {},
}));

import { AppshotFlyIn, flightMotion } from "./AppshotFlyIn";

afterEach(cleanup);

const rect = { x: 400, y: 200, w: 400, h: 300 };
const chip = { x: 100, y: 700, w: 40, h: 30 };

describe("flightMotion", () => {
  it("enters like a dialog and glides to its chip on the drawer curve", () => {
    const enter = flightMotion({ reduce: false, rect, target: null });
    expect(enter.initial).toEqual({ opacity: 0, scale: 0.95 });
    expect(enter.transition).toMatchObject({ duration: DUR.slow });
    const glide = flightMotion({ reduce: false, rect, target: chip });
    expect(glide.animate).toMatchObject({ x: -480, y: 365, scale: 0.1, opacity: [1, 1, 0] });
    expect(glide.transition).toMatchObject({ duration: DUR.drawer, ease: EASE_DRAWER });
  });

  it("under reduced motion fades in and out in place, never in one frame", () => {
    for (const target of [null, chip]) {
      const { initial, animate, transition } = flightMotion({ reduce: true, rect, target });
      for (const keys of [initial, animate]) {
        expect(keys).not.toHaveProperty("x");
        expect(keys).not.toHaveProperty("y");
        expect(keys).not.toHaveProperty("scale");
      }
      expect(transition.duration).toBe(DUR.fast);
    }
  });
});

describe("AppshotFlyIn", () => {
  it("draws no flash while the capture loads", () => {
    render(<AppshotFlyIn sessionId="s1" active />);
    const layer = document.body.querySelector(".fixed.inset-0") as HTMLElement;
    expect(layer).not.toBeNull();
    expect(layer.children).toHaveLength(0);
  });
});
