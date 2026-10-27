import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LAYER } from "./layers";

describe("LAYER", () => {
  it("matches the --layer tokens and puts menus above dialogs", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    for (const name of ["dialog", "popover", "toast"] as const) {
      expect(css).toContain(`--layer-${name}: ${LAYER[name]};`);
    }
    expect(LAYER.popover).toBeGreaterThan(LAYER.dialog);
    expect(LAYER.submenu).toBeGreaterThan(LAYER.popover);
  });
});
