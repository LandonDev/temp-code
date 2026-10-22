import { describe, expect, it } from "vitest";
import { LAYER, liftedLayer } from "./layers";

describe("liftedLayer", () => {
  it("keeps a surface's own layer at the root and lifts it above a dialog it opened from", () => {
    expect(liftedLayer(LAYER.popover, null)).toBe(LAYER.popover);
    expect(liftedLayer(LAYER.popover, LAYER.dialog)).toBe(LAYER.dialog + 1);
    expect(liftedLayer(LAYER.submenu, LAYER.dialog)).toBe(LAYER.dialog + 2);
    expect(liftedLayer(LAYER.toast, LAYER.dialog)).toBe(LAYER.dialog + 1 + (LAYER.toast - LAYER.popover));
  });
});
