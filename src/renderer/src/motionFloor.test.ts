import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "index.css"), "utf8") + readFileSync(resolve(__dirname, "surfaces/transcript/transcript.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("the motion floor", () => {
  it("lands the send bubble inside the UI budget, on the tokens", () => {
    expect(rule(".bubble-send-flip")).toContain("animation: bubble-send-flip var(--dur-slow) var(--ease-drawer) both;");
    expect(rule(".bubble-send-in")).toContain("animation: bubble-send-in var(--dur-slow) var(--ease-drawer) both;");
  });

  it("has no modal or popover-exit keyframes left from the ghost exits", () => {
    expect(css).not.toMatch(/@keyframes (modal-|popover-close|popover-open|approval-toast)/);
    expect(css).not.toMatch(/\.(modal-panel|modal-backdrop|modal-closing|popover-close|approval-toast)\b/);
  });

  it("keeps a --dur-fast fade on overlays under reduced motion", () => {
    // Overlays move on transitions, so reduced motion narrows them to opacity.
    const overlays = css.split("@media (prefers-reduced-motion: reduce)").slice(1).find((block) => block.includes('[data-slot="dialog-content"]')) ?? "";
    for (const slot of ["dialog-content", "sheet-content", "popover-content", "dropdown-menu-content", "select-content", "tooltip-content"]) {
      expect(overlays, slot).toContain(`[data-slot="${slot}"]`);
    }
    const body = overlays.match(/\) \{([^}]*)\}/)?.[1] ?? "";
    expect(body).toContain("transition-property: opacity;");
    expect(body).toContain("transition-duration: var(--dur-fast);");
  });
});
